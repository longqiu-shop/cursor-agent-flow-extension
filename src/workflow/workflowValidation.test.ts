import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition, WorkflowStep } from '../types';
import { validateWorkflowDefinition } from './workflowValidation';
import { createWorkflowSchemaRegistry } from './workflowSchemas';

const agentStep = (id: string): WorkflowStep => ({
  id,
  type: 'agent',
  input: {
    title: id,
    prompt: `Run ${id}`
  },
  output: {
    path: `${id}.md`,
    format: 'markdown'
  }
});

const workflowWithFanoutInput = (input: Record<string, unknown>): WorkflowDefinition => ({
  id: 'unit-workflow',
  name: 'Unit Workflow',
  filePath: '.cursor/workflows/unit.json',
  version: 1,
  steps: [
    {
      id: 'fanout-prs',
      type: 'fanout',
      input
    }
  ]
});

const workflowWithAgentInput = (input: Record<string, unknown>): WorkflowDefinition => ({
  id: 'unit-workflow',
  name: 'Unit Workflow',
  filePath: '.cursor/workflows/unit.json',
  version: 1,
  steps: [
    {
      id: 'scan-prs',
      type: 'agent',
      input,
      output: {
        path: 'scan/prs.json',
        format: 'json'
      }
    }
  ]
});

test('validates agent input.promptFile as an alternative to inline prompt', () => {
  const result = validateWorkflowDefinition(workflowWithAgentInput({
    title: 'Scan PRs',
    promptFile: 'scan-prs.md'
  }));

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects agent input with both prompt and promptFile', () => {
  const result = validateWorkflowDefinition(workflowWithAgentInput({
    title: 'Scan PRs',
    prompt: 'Scan Slack',
    promptFile: 'scan-prs.md'
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Agent step scan-prs input must use either prompt or promptFile, not both'
  ]);
});

test('rejects agent input without prompt or promptFile', () => {
  const result = validateWorkflowDefinition(workflowWithAgentInput({
    title: 'Scan PRs'
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Agent step scan-prs input.prompt or input.promptFile is required'
  ]);
});

test('rejects agent promptFile paths outside the workflow directory', () => {
  const result = validateWorkflowDefinition(workflowWithAgentInput({
    title: 'Scan PRs',
    promptFile: '../scan-prs.md'
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Agent step scan-prs input.promptFile must not traverse outside the workflow directory'
  ]);
});

test('allows extension-owned workflow assets to reference sibling prompt assets', () => {
  const workflow = workflowWithAgentInput({
    title: 'Plan',
    promptFile: '../prompts/agentic-workflow-planner.md'
  });
  workflow.filePath = '/extension/out/assets/workflows/agentic-workflow-bootstrap.json';

  const result = validateWorkflowDefinition(workflow);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates legacy fanout input.step', () => {
  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    step: agentStep('review-pr')
  }));

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates multi-step fanout input.steps', () => {
  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    steps: [
      agentStep('review-pr'),
      agentStep('comment-pr')
    ]
  }));

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects fanout with both step and steps', () => {
  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    step: agentStep('review-pr'),
    steps: [agentStep('comment-pr')]
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'fanout step fanout-prs input must use either step or steps, not both'
  ]);
});

test('rejects empty fanout steps array', () => {
  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    steps: []
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'fanout step fanout-prs input.steps must be a non-empty array of workflow steps'
  ]);
});

test('rejects nested fanout inside multi-step fanout', () => {
  const nestedFanout: WorkflowStep = {
    id: 'nested',
    type: 'fanout',
    input: {
      itemsFrom: 'steps.other.output',
      step: agentStep('inner')
    }
  };

  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    steps: [
      agentStep('review-pr'),
      nestedFanout
    ]
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Nested fanout is not supported in step fanout-prs'
  ]);
});

test('rejects duplicate child step ids in multi-step fanout', () => {
  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    steps: [
      agentStep('review-pr'),
      agentStep('review-pr')
    ]
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Duplicate workflow step id: review-pr'
  ]);
});

test('rejects invalid child step input in multi-step fanout', () => {
  const invalidAgent: WorkflowStep = {
    id: 'comment-pr',
    type: 'agent',
    input: {
      title: 'Comment PR'
    },
    output: {
      path: 'comments/pr.md',
      format: 'markdown'
    }
  };

  const result = validateWorkflowDefinition(workflowWithFanoutInput({
    itemsFrom: 'steps.read-prs.output',
    steps: [
      agentStep('review-pr'),
      invalidAgent
    ]
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'Agent step comment-pr input.prompt or input.promptFile is required'
  ]);
});

test('validates existing static workflow step types after adding plan runtime types', () => {
  const workflow: WorkflowDefinition = {
    id: 'static-regression',
    name: 'Static Regression',
    filePath: '.cursor/workflows/static-regression.json',
    version: 1,
    steps: [
      agentStep('scan'),
      {
        id: 'read-items',
        type: 'readJson',
        input: {
          path: 'scan.md',
          select: 'items'
        }
      },
      {
        id: 'fanout-items',
        type: 'fanout',
        input: {
          itemsFrom: 'steps.read-items.output',
          step: agentStep('process-item')
        }
      },
      {
        id: 'join-items',
        type: 'join',
        input: {
          from: 'items/*.md',
          outputPath: 'summary/items.md'
        }
      }
    ]
  };

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates toolInventory workflow steps', () => {
  const workflow: WorkflowDefinition = {
    id: 'inventory-workflow',
    name: 'Inventory Workflow',
    filePath: '.cursor/workflows/inventory.json',
    version: 1,
    steps: [
      {
        id: 'inventory',
        type: 'toolInventory',
        input: {
          include: ['skills', 'agents', 'commands', 'workflowPrimitives', 'runtimeActions']
        },
        output: {
          path: 'tool-inventory.json',
          format: 'json',
          schema: 'tool-inventory@1'
        }
      }
    ]
  };

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects invalid toolInventory workflow steps', () => {
  const workflow: WorkflowDefinition = {
    id: 'inventory-workflow',
    name: 'Inventory Workflow',
    filePath: '.cursor/workflows/inventory.json',
    version: 1,
    steps: [
      {
        id: 'inventory',
        type: 'toolInventory',
        input: {
          include: ['skills', 123]
        },
        output: {
          path: 'tool-inventory.txt',
          format: 'text',
          schema: 'wrong-schema'
        }
      }
    ]
  };

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'step inventory output.schema is not registered: wrong-schema',
    'toolInventory step inventory input.include must be an array of non-empty strings',
    'toolInventory step inventory output.format must be json',
    'toolInventory step inventory output.schema must be tool-inventory@1'
  ]);
});

test('validates planRuntime workflow steps', () => {
  const workflow: WorkflowDefinition = {
    id: 'plan-runtime-workflow',
    name: 'Plan Runtime Workflow',
    filePath: '.cursor/workflows/plan-runtime.json',
    version: 1,
    steps: [
      {
        id: 'execute-plan',
        type: 'planRuntime',
        input: {
          planArtifact: 'plan/master-plan.json',
          toolInventoryArtifact: 'tool-inventory.json'
        },
        output: {
          path: 'plan-run.json',
          format: 'json',
          schema: 'plan-run@1'
        }
      }
    ]
  };

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects invalid planRuntime workflow steps', () => {
  const workflow: WorkflowDefinition = {
    id: 'plan-runtime-workflow',
    name: 'Plan Runtime Workflow',
    filePath: '.cursor/workflows/plan-runtime.json',
    version: 1,
    steps: [
      {
        id: 'execute-plan',
        type: 'planRuntime',
        input: {
          planArtifact: '../plan/master-plan.json'
        },
        output: {
          path: 'plan-run.txt',
          format: 'text',
          schema: 'tool-inventory@1'
        }
      }
    ]
  };

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'planRuntime step execute-plan input.planArtifact must not traverse outside runDir',
    'planRuntime step execute-plan input.toolInventoryArtifact is required',
    'planRuntime step execute-plan output.format must be json',
    'planRuntime step execute-plan output.schema must be plan-run@1'
  ]);
});
