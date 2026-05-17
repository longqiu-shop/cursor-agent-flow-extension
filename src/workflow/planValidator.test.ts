import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanValidator, PLAN_VALIDATION_ERROR_CODES } from './planValidator';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import type { MasterPlan, ToolInventory } from './planSchemas';

const toolInventory: ToolInventory = {
  schemaVersion: '1',
  tools: [
    {
      id: 'workflow.readJson',
      source: 'workflowPrimitives',
      capabilities: ['read'],
      description: 'Read JSON'
    },
    {
      id: 'workflow.agent',
      source: 'workflowPrimitives',
      capabilities: ['read', 'workspaceWrite'],
      description: 'Run agent'
    }
  ]
};

function validPlan(overrides: Partial<MasterPlan> = {}): MasterPlan {
  return {
    schemaVersion: '1',
    objective: 'Summarize changes',
    riskLevel: 'low',
    allowedCapabilities: ['read'],
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            id: 'summarize-changes',
            type: 'agent',
            goal: 'Summarize changes',
            successCriteria: ['Summary exists'],
            evidenceRequired: ['tasks/summarize/summarize-changes/output.md'],
            confidencePolicy: {
              requireAllCriteria: true,
              requireAllEvidence: true,
              onFailure: 'block'
            },
            expectedOutputs: [
              {
                path: 'tasks/summarize/summarize-changes/output.md',
                format: 'markdown',
                required: true
              }
            ],
            tools: ['workflow.readJson']
          }
        ]
      }
    ],
    ...overrides
  };
}

test('validates a capability-aware master plan against the tool inventory', () => {
  const validator = new PlanValidator();
  const result = validator.validate(validPlan(), {
    toolInventory,
    allowedCapabilities: ['read'],
    schemaRegistry: createWorkflowSchemaRegistry()
  });

  assert.equal(result.valid, true);
  assert.equal(result.plan?.objective, 'Summarize changes');
  assert.deepEqual(result.artifact.errors, []);
});

test('returns structured validation error for unparseable planner JSON', () => {
  const validator = new PlanValidator();
  const result = validator.validateJsonContent('{not json', { toolInventory });

  assert.equal(result.valid, false);
  assert.equal(result.artifact.errors[0].code, PLAN_VALIDATION_ERROR_CODES.JSON_PARSE_ERROR);
});

test('rejects unknown tools and disallowed tool capabilities', () => {
  const validator = new PlanValidator();
  const plan = validPlan({
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...validPlan().stages[0].tasks[0],
            tools: ['missing.tool', 'workflow.agent']
          }
        ]
      }
    ]
  });

  const result = validator.validate(plan, {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.UNKNOWN_TOOL,
    PLAN_VALIDATION_ERROR_CODES.TOOL_CAPABILITY_NOT_ALLOWED
  ]);
});

test('rejects runtime capabilities that are not allowed by policy', () => {
  const validator = new PlanValidator();
  const result = validator.validate(validPlan({ allowedCapabilities: ['read', 'workspaceWrite'] }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.UNKNOWN_CAPABILITY
  ]);
});

test('requires approval for high-risk plans', () => {
  const validator = new PlanValidator();
  const result = validator.validate(validPlan({ riskLevel: 'high' }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.HIGH_RISK_REQUIRES_APPROVAL
  ]);

  const approved = validator.validate(validPlan({
    riskLevel: 'high',
    requiresApproval: true
  }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(approved.valid, true);
  assert.deepEqual(approved.artifact.errors, []);
});

test('accepts valid single-role task-boundary metadata', () => {
  const validator = new PlanValidator();
  const baseTask = validPlan().stages[0].tasks[0];
  const result = validator.validate(validPlan({
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...baseTask,
            role: 'producer',
            taskBoundary: {
              role: 'producer',
              maxAgentInvocations: 1,
              description: 'Produce the requested summary only'
            },
            outputPurpose: 'artifact'
          }
        ]
      }
    ]
  }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.artifact.errors, []);
});

test('rejects ambiguous goals, multiple roles, and multi-agent task claims', () => {
  const validator = new PlanValidator();
  const baseTask = validPlan().stages[0].tasks[0];
  const result = validator.validate(validPlan({
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...baseTask,
            goal: 'Do it',
            role: 'reviewer and verifier',
            taskBoundary: {
              maxAgentInvocations: 2
            }
          }
        ]
      }
    ]
  }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.AMBIGUOUS_TASK_GOAL,
    PLAN_VALIDATION_ERROR_CODES.MULTIPLE_TASK_ROLES,
    PLAN_VALIDATION_ERROR_CODES.MULTI_AGENT_TASK
  ]);
});

test('requires side-effect tasks to declare prior validation evidence', () => {
  const validator = new PlanValidator();
  const baseTask = validPlan().stages[0].tasks[0];
  const result = validator.validate(validPlan({
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...baseTask,
            id: 'post-comments',
            goal: 'Post validated review comments',
            role: 'poster',
            outputPurpose: 'sideEffect'
          }
        ]
      }
    ]
  }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.SIDE_EFFECT_REQUIRES_DEPENDENCY
  ]);
});

test('accepts independent verification and posting split across one-agent tasks', () => {
  const validator = new PlanValidator();
  const reviewOutput = 'tasks/review/candidate-review/output.md';
  const verificationOutput = 'tasks/review/verify-review/output.json';
  const postOutput = 'tasks/review/post-comments/posted-comments.json';
  const baseTask = validPlan().stages[0].tasks[0];
  const result = validator.validate(validPlan({
    objective: 'Review a PR, double-check concerns, then post comments',
    stages: [
      {
        id: 'review',
        tasks: [
          {
            ...baseTask,
            id: 'candidate-review',
            goal: 'Draft candidate PR review findings',
            role: 'reviewer',
            taskBoundary: { role: 'reviewer', maxAgentInvocations: 1 },
            outputPurpose: 'analysis',
            evidenceRequired: [reviewOutput],
            expectedOutputs: [{ path: reviewOutput, format: 'markdown', required: true }]
          },
          {
            ...baseTask,
            id: 'verify-review',
            goal: 'Independently verify candidate PR review findings',
            role: 'verifier',
            taskBoundary: { role: 'verifier', maxAgentInvocations: 1 },
            dependsOn: ['candidate-review'],
            inputArtifacts: [reviewOutput],
            outputPurpose: 'verification',
            evidenceRequired: [verificationOutput],
            expectedOutputs: [{ path: verificationOutput, format: 'json', required: true }]
          },
          {
            ...baseTask,
            id: 'post-comments',
            goal: 'Post only verified PR review comments',
            role: 'poster',
            taskBoundary: { role: 'poster', maxAgentInvocations: 1 },
            dependsOn: ['verify-review'],
            inputArtifacts: [verificationOutput],
            outputPurpose: 'sideEffect',
            evidenceRequired: [postOutput],
            expectedOutputs: [{ path: postOutput, format: 'json', required: true }]
          }
        ]
      }
    ]
  }), {
    toolInventory,
    allowedCapabilities: ['read']
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.artifact.errors, []);
});

test('rejects unsafe, duplicate, and unknown-schema expected outputs', () => {
  const validator = new PlanValidator();
  const baseTask = validPlan().stages[0].tasks[0];
  const plan = validPlan({
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...baseTask,
            expectedOutputs: [
              {
                path: '../outside.md',
                format: 'markdown'
              },
              {
                path: 'tasks/summarize/summarize-changes/output.json',
                format: 'json',
                schema: 'unknown@1'
              },
              {
                path: 'tasks/summarize/summarize-changes/output.json',
                format: 'json'
              }
            ]
          }
        ]
      }
    ]
  });

  const result = validator.validate(plan, {
    toolInventory,
    schemaRegistry: createWorkflowSchemaRegistry()
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.artifact.errors.map(error => error.code), [
    PLAN_VALIDATION_ERROR_CODES.UNSAFE_OUTPUT_PATH,
    PLAN_VALIDATION_ERROR_CODES.UNKNOWN_OUTPUT_SCHEMA,
    PLAN_VALIDATION_ERROR_CODES.DUPLICATE_OUTPUT_PATH
  ]);
});
