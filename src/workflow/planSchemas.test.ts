import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_SCHEMA_ID,
  MASTER_PLAN_SCHEMA_ID,
  PLAN_RUN_SCHEMA_ID,
  TRACE_EVENT_SCHEMA_ID,
  TOOL_INVENTORY_SCHEMA_ID,
  TOOL_USE_EVIDENCE_SCHEMA_ID,
  WORKFLOW_PREFERENCES_SCHEMA_ID
} from './planSchemas';
import { createWorkflowSchemaRegistry } from './workflowSchemas';

const validMasterPlan = {
  schemaVersion: '1',
  objective: 'Summarize git changes',
  riskLevel: 'low',
  allowedCapabilities: ['read'],
  stages: [
    {
      id: 'summarize',
      name: 'Summarize',
      tasks: [
        {
          id: 'summarize-git-changes',
          type: 'agent',
          goal: 'Create a Markdown summary',
          successCriteria: ['Summary mentions changed files'],
          evidenceRequired: ['tasks/summarize/summarize-git-changes/output.md'],
          confidencePolicy: {
            requireAllCriteria: true,
            requireAllEvidence: true,
            onFailure: 'block'
          },
          expectedOutputs: [
            {
              path: 'tasks/summarize/summarize-git-changes/output.md',
              format: 'markdown',
              required: true
            }
          ],
          tools: []
        }
      ]
    }
  ]
};

test('registers built-in plan runtime schemas', () => {
  const registry = createWorkflowSchemaRegistry();

  assert.equal(registry.has(MASTER_PLAN_SCHEMA_ID), true);
  assert.equal(registry.has(AUDIT_SCHEMA_ID), true);
  assert.equal(registry.has(TOOL_INVENTORY_SCHEMA_ID), true);
  assert.equal(registry.has(TOOL_USE_EVIDENCE_SCHEMA_ID), true);
  assert.equal(registry.has(WORKFLOW_PREFERENCES_SCHEMA_ID), true);
  assert.equal(registry.has(PLAN_RUN_SCHEMA_ID), true);
  assert.equal(registry.has(TRACE_EVENT_SCHEMA_ID), true);
});

test('validates workflow preferences artifact with built-in default source', () => {
  const registry = createWorkflowSchemaRegistry();
  const artifact = {
    schemaVersion: '1',
    preferences: [{
      id: 'default-task-boundaries',
      source: 'builtInDefault',
      title: 'Default Task Boundaries',
      summary: 'Split responsibilities into separate tasks.',
      content: 'Prefer one role per task.',
      contentSha256: 'abc123'
    }]
  };

  const result = registry.validate(WORKFLOW_PREFERENCES_SCHEMA_ID, artifact);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates a minimal master plan artifact', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(MASTER_PLAN_SCHEMA_ID, validMasterPlan);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, validMasterPlan);
});

test('validates optional task-boundary metadata on master plan tasks', () => {
  const registry = createWorkflowSchemaRegistry();
  const task = validMasterPlan.stages[0].tasks[0];
  const plan = {
    ...validMasterPlan,
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...task,
            role: 'producer',
            taskBoundary: {
              role: 'producer',
              maxAgentInvocations: 1,
              description: 'Produce the summary only'
            },
            dependsOn: [],
            inputArtifacts: [],
            outputPurpose: 'artifact'
          }
        ]
      }
    ]
  };

  const result = registry.validate(MASTER_PLAN_SCHEMA_ID, plan);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, plan);
});

test('rejects expected outputs with unvalidated fields', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(MASTER_PLAN_SCHEMA_ID, {
    ...validMasterPlan,
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...validMasterPlan.stages[0].tasks[0],
            expectedOutputs: [
              {
                path: 'tasks/summarize/summarize-git-changes/output.json',
                format: 'json',
                schema: '',
                description: 'planner-invented output metadata'
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'master-plan@1.stages[0].tasks[0].expectedOutputs[0].description is not allowed',
    'master-plan@1.stages[0].tasks[0].expectedOutputs[0].schema must be a non-empty string'
  ]);
});

test('rejects malformed master plan artifacts with stable schema-version errors', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(MASTER_PLAN_SCHEMA_ID, {
    ...validMasterPlan,
    schemaVersion: '2',
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            id: 'bad-task',
            type: 'agent'
          }
        ]
      }
    ]
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'SCHEMA_VERSION_MISMATCH: master-plan@1.schemaVersion must be 1',
    'master-plan@1.stages[0].tasks[0].goal must be a non-empty string',
    'master-plan@1.stages[0].tasks[0].successCriteria must be a non-empty array',
    'master-plan@1.stages[0].tasks[0].evidenceRequired must be a non-empty array',
    'master-plan@1.stages[0].tasks[0].confidencePolicy must be object',
    'master-plan@1.stages[0].tasks[0].expectedOutputs must be a non-empty array'
  ]);
});

test('validates plan-run status-aware requirements', () => {
  const registry = createWorkflowSchemaRegistry();

  assert.equal(registry.validate(PLAN_RUN_SCHEMA_ID, {
    schemaVersion: '1',
    status: 'validating'
  }).valid, true);

  const runningResult = registry.validate(PLAN_RUN_SCHEMA_ID, {
    schemaVersion: '1',
    status: 'running'
  });

  assert.equal(runningResult.valid, false);
  assert.deepEqual(runningResult.errors, [
    'plan-run@1.planId must be a non-empty string',
    'plan-run@1.planHash must be a non-empty string',
    'plan-run@1.stages must be array after plan validation'
  ]);
});

test('validates audit artifacts without top-level passed field', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(AUDIT_SCHEMA_ID, {
    schemaVersion: '1',
    criteriaResults: [
      {
        criterion: 'Output matches schema',
        passed: true,
        evidence: ['tasks/summarize/summarize-git-changes/validation.json']
      }
    ],
    missingEvidence: [],
    risks: [],
    nextAction: 'advance'
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates tool inventory artifacts', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(TOOL_INVENTORY_SCHEMA_ID, {
    schemaVersion: '1',
    tools: [
      {
        id: 'workflow.agent',
        source: 'workflowPrimitives',
        capabilities: ['read'],
        description: 'Run a Cursor agent task'
      },
      {
        id: 'mcp.user-github.list_pull_requests',
        source: 'mcpTools',
        capabilities: ['read'],
        description: 'List GitHub pull requests'
      }
    ]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validates MCP tool-use evidence artifacts', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(TOOL_USE_EVIDENCE_SCHEMA_ID, {
    schemaVersion: '1',
    claimedToolsUsed: ['mcp.user-github.list_pull_requests'],
    evidence: ['Queried open pull requests for owner/repo and summarized result URLs.']
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('trace events store references instead of large content bodies', () => {
  const registry = createWorkflowSchemaRegistry();
  const result = registry.validate(TRACE_EVENT_SCHEMA_ID, {
    schemaVersion: '1',
    id: 'event-1',
    type: 'agent.prompted',
    timestamp: '2026-05-16T00:00:00.000Z',
    refs: {
      promptPath: 'tasks/summarize/summarize-git-changes/prompt.md'
    },
    content: 'large prompt content'
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'trace-event@1.content is not allowed; store references and hashes instead'
  ]);
});
