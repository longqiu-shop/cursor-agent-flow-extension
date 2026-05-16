import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition, WorkflowStep } from '../types';
import { validateWorkflowDefinition } from './workflowValidation';

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
