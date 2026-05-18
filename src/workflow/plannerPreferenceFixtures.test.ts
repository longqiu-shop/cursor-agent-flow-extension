import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MasterPlan, PlanTask, ToolInventory } from './planSchemas';
import { PlanValidator } from './planValidator';
import { renderTemplate } from './variableResolver';
import { WorkflowPreferenceProvider } from './workflowPreferenceProvider';
import { createWorkflowSchemaRegistry } from './workflowSchemas';

const toolInventory: ToolInventory = {
  schemaVersion: '1',
  tools: [
    {
      id: 'workflow.agent',
      source: 'workflowPrimitives',
      capabilities: ['read', 'workspaceWrite'],
      description: 'Run agent'
    },
    {
      id: 'workflowPreferences.pr-review-flow',
      source: 'workflowPreferences',
      capabilities: ['planning'],
      title: 'PR Review Flow',
      summary: 'For PR reviews, split review, verification, synthesis, and posting.'
    },
    {
      id: 'workflowPreferences.no-post',
      source: 'workflowPreferences',
      capabilities: ['planning'],
      title: 'No Post',
      summary: 'Do not post comments unless explicitly asked.'
    }
  ]
};

test('freeform PR preference note is normalized and reaches planner prompt as artifact context', () => {
  const preferenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-preference-fixture-'));
  fs.writeFileSync(path.join(preferenceDir, 'pr-review-flow.md'), [
    '# PR Review Flow',
    '',
    'For PR review goals, create review, independent verification, synthesis, and posting tasks.',
    'If another preference says not to post, omit the posting task.'
  ].join('\n'), 'utf-8');
  const snapshot = new WorkflowPreferenceProvider({
    builtInDefaults: [],
    projectDirectories: [preferenceDir]
  }).snapshot();
  const promptTemplate = fs.readFileSync(path.resolve(process.cwd(), 'src/assets/prompts/agentic-workflow-planner.md'), 'utf-8');

  const renderedPrompt = renderTemplate(promptTemplate, {
    trigger: {
      goal: 'Review PR 123'
    },
    steps: {
      inventory: {
        outputArtifact: '/tmp/run/tool-inventory.json'
      },
      preferences: {
        outputArtifact: '/tmp/run/preferences/workflow-preferences.json'
      }
    }
  });

  assert.deepEqual(snapshot.preferences.map(preference => preference.id), ['pr-review-flow']);
  assert.equal(snapshot.preferences[0].source, 'project');
  assert.match(snapshot.preferences[0].content, /independent verification, synthesis, and posting/);
  assert.match(renderedPrompt, /Workflow preferences artifact:\n\/tmp\/run\/preferences\/workflow-preferences\.json/);
  assert.match(renderedPrompt, /Read the tool inventory and workflow preferences before choosing tools/);
  assert.match(renderedPrompt, /workflowPreferences\.selectedPreferenceIds/);
});

test('PR workflow preference fixture validates review, verify, synthesize, and post task shape', () => {
  const plan = masterPlan([
    task('review-pr', 'reviewer', 'Review the pull request and write candidate findings', 'analysis'),
    task('verify-findings', 'verifier', 'Independently verify the candidate review findings', 'verification', {
      dependsOn: ['review-pr'],
      inputArtifacts: ['tasks/execute/review-pr/output.md']
    }),
    task('synthesize-review', 'synthesizer', 'Synthesize verified findings into final review comments', 'synthesis', {
      dependsOn: ['verify-findings'],
      inputArtifacts: ['tasks/execute/verify-findings/output.md']
    }),
    task('post-comments', 'poster', 'Post the synthesized PR review comments', 'sideEffect', {
      dependsOn: ['synthesize-review'],
      inputArtifacts: ['tasks/execute/synthesize-review/output.md']
    })
  ], {
    selectedPreferenceIds: ['pr-review-flow'],
    interpretedRequirements: ['Split PR review work into review, verification, synthesis, and posting tasks.'],
    conflicts: []
  });

  const result = new PlanValidator().validate(plan, {
    toolInventory,
    allowedCapabilities: ['read', 'workspaceWrite'],
    schemaRegistry: createWorkflowSchemaRegistry()
  });

  assert.equal(result.valid, true);
  assert.deepEqual(plan.stages[0].tasks.map(task => task.role), ['reviewer', 'verifier', 'synthesizer', 'poster']);
});

test('no-post workflow preference fixture validates that post-comment side effect is omitted', () => {
  const plan = masterPlan([
    task('review-pr', 'reviewer', 'Review the pull request and write candidate findings', 'analysis'),
    task('verify-findings', 'verifier', 'Independently verify the candidate review findings', 'verification', {
      dependsOn: ['review-pr'],
      inputArtifacts: ['tasks/execute/review-pr/output.md']
    }),
    task('synthesize-review', 'synthesizer', 'Synthesize verified findings without posting comments', 'synthesis', {
      dependsOn: ['verify-findings'],
      inputArtifacts: ['tasks/execute/verify-findings/output.md']
    })
  ], {
    selectedPreferenceIds: ['pr-review-flow', 'no-post'],
    interpretedRequirements: [
      'Split PR review work into review, verification, and synthesis tasks.',
      'Do not create a post-comment side-effect task.'
    ],
    conflicts: []
  });

  const result = new PlanValidator().validate(plan, {
    toolInventory,
    allowedCapabilities: ['read', 'workspaceWrite'],
    schemaRegistry: createWorkflowSchemaRegistry()
  });

  assert.equal(result.valid, true);
  assert.equal(plan.stages[0].tasks.some(task => task.role === 'poster' || task.outputPurpose === 'sideEffect'), false);
});

function masterPlan(tasks: PlanTask[], workflowPreferences: MasterPlan['workflowPreferences']): MasterPlan {
  return {
    schemaVersion: '1',
    objective: 'Review pull request 123',
    riskLevel: 'low',
    allowedCapabilities: ['read', 'workspaceWrite'],
    workflowPreferences,
    stages: [{
      id: 'execute',
      name: 'Execute PR review',
      tasks
    }]
  };
}

function task(
  id: string,
  role: string,
  goal: string,
  outputPurpose: string,
  options: { dependsOn?: string[]; inputArtifacts?: string[] } = {}
): PlanTask {
  const outputPath = `tasks/execute/${id}/output.md`;
  return {
    id,
    type: 'agent',
    role,
    goal,
    taskBoundary: {
      role,
      maxAgentInvocations: 1,
      description: `Perform only the ${role} responsibility.`
    },
    dependsOn: options.dependsOn ?? [],
    inputArtifacts: options.inputArtifacts ?? [],
    outputPurpose,
    successCriteria: [`${role} output is produced`],
    evidenceRequired: [outputPath],
    confidencePolicy: {
      requireAllCriteria: true,
      requireAllEvidence: true,
      onFailure: 'block'
    },
    expectedOutputs: [{
      path: outputPath,
      format: 'markdown',
      required: true
    }],
    tools: ['workflow.agent']
  };
}
