import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanRuntimeStepExecutor } from './planRuntimeStepExecutor';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import type { MasterPlan, PlanRun, ToolInventory } from './planSchemas';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { StepExecutionResult, WorkflowExecutionContext } from './workflowRunner';
import type { ArtifactStore } from './artifactStore';
import type { WorkflowVariables } from './variableResolver';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-plan-runtime-'));
}

function validPlan(): MasterPlan {
  return {
    schemaVersion: '1',
    objective: 'Summarize changes',
    riskLevel: 'low',
    allowedCapabilities: ['read', 'workspaceWrite'],
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            id: 'summarize-changes',
            type: 'agent',
            goal: 'Write a change summary',
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
            tools: ['workflow.agent']
          }
        ]
      }
    ]
  };
}

const toolInventory: ToolInventory = {
  schemaVersion: '1',
  tools: [
    {
      id: 'workflow.agent',
      source: 'workflowPrimitives',
      capabilities: ['read', 'workspaceWrite'],
      description: 'Run an agent task'
    }
  ]
};

const toolInventoryWithMcp: ToolInventory = {
  schemaVersion: '1',
  tools: [
    ...toolInventory.tools,
    {
      id: 'mcp.user-github.list_pull_requests',
      source: 'mcpTools',
      capabilities: ['read'],
      description: 'List GitHub pull requests'
    }
  ]
};

const planRuntimeStep: WorkflowStep = {
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
};

interface RuntimeContextOptions {
  variables?: WorkflowVariables;
  tokenCancelled?: boolean;
  childResult?: StepExecutionResult;
  onChildStep?: (step: WorkflowStep, artifactStore: ReturnType<typeof createArtifactStore>) => void;
}

function createArtifactStore(runDir: string): Pick<ArtifactStore, 'resolveArtifactPath' | 'writeJson' | 'writeText' | 'readJson' | 'readText'> {
  const resolveArtifactPath = (artifactPath: string): string => {
    if (!artifactPath || path.isAbsolute(artifactPath)) {
      throw new Error(`Path must be relative to runDir: ${artifactPath}`);
    }
    const resolved = path.resolve(runDir, artifactPath);
    const relative = path.relative(runDir, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes runDir: ${artifactPath}`);
    }
    return resolved;
  };

  return {
    resolveArtifactPath,
    writeJson: (artifactPath: string, value: unknown) => {
      const resolved = resolveArtifactPath(artifactPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
      return resolved;
    },
    writeText: (artifactPath: string, value: string) => {
      const resolved = resolveArtifactPath(artifactPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, value, 'utf-8');
      return resolved;
    },
    readJson: <T>(artifactPath: string): T | undefined => {
      const resolved = resolveArtifactPath(artifactPath);
      if (!fs.existsSync(resolved)) {
        return undefined;
      }
      return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as T;
    },
    readText: (artifactPath: string): string | undefined => {
      const resolved = resolveArtifactPath(artifactPath);
      return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : undefined;
    }
  };
}

function createContext(runDir: string, childCalls: WorkflowStep[], options: RuntimeContextOptions = {}): WorkflowExecutionContext {
  const artifactStore = createArtifactStore(runDir);
  return {
    workflow: {
      id: 'agentic-bootstrap',
      name: 'Agentic Bootstrap',
      filePath: '.cursor/workflows/agentic-bootstrap.json',
      version: 1,
      steps: [planRuntimeStep]
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'agentic-bootstrap',
      workflowName: 'Agentic Bootstrap',
      status: 'running',
      runDir,
      startedAt: '2026-05-16T00:00:00.000Z',
      steps: []
    } satisfies WorkflowRun,
    artifactStore: artifactStore as ArtifactStore,
    variables: {
      runDir,
      ...options.variables
    },
    token: {
      isCancellationRequested: options.tokenCancelled ?? false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as WorkflowExecutionContext['token'],
    executeChildStep: async step => {
      childCalls.push(step);
      options.onChildStep?.(step, artifactStore);
      const childResult = options.childResult ?? { status: 'succeeded' as const };
      const outputSpec = step.output;
      const shouldWriteDefaultOutput = childResult.status === 'succeeded' && outputSpec && !fs.existsSync(path.join(runDir, outputSpec.path));
      const outputPath = shouldWriteDefaultOutput
        ? artifactStore.writeText(outputSpec.path, '# Summary\n', {})
        : outputSpec
          ? path.join(runDir, outputSpec.path)
          : undefined;
      const stepRun: WorkflowStepRun = {
        stepRunId: `child-${childCalls.length}`,
        definitionId: step.id,
        type: step.type,
        status: childResult.status,
        outputArtifact: outputPath
      };
      return {
        stepRun,
        result: {
          ...childResult,
          outputArtifact: childResult.outputArtifact ?? outputPath
        }
      };
    }
  };
}

function planWithMcpTool(): MasterPlan {
  const plan = validPlan();
  plan.stages[0].tasks[0].tools = ['workflow.agent', 'mcp.user-github.list_pull_requests'];
  return plan;
}

function writeBaseRuntimeInputs(
  artifactStore: ReturnType<typeof createArtifactStore>,
  plan: MasterPlan = validPlan(),
  inventory: ToolInventory = toolInventory
): void {
  artifactStore.writeJson('plan/master-plan.json', plan);
  artifactStore.writeJson('tool-inventory.json', inventory);
}

test('planRuntime executes a valid one-task plan through audit and confidence', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');
  const audit = artifactStore.readJson('audits/summarize/summarize-changes/audit.json');

  assert.equal(result.status, 'succeeded');
  assert.equal(planRun?.status, 'succeeded');
  assert.equal(planRun?.tasks?.[0].status, 'succeeded');
  assert.equal(childCalls.length, 1);
  assert.equal(childCalls[0].type, 'agent');
  assert.match((childCalls[0].input as { prompt: string }).prompt, /Task output contract/);
  assert.equal(audit !== undefined, true);
  assert.equal(fs.existsSync(path.join(runDir, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'trace.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'artifact-lineage.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'decision-log.md')), true);
});

test('planRuntime accepts templated absolute artifact paths inside the run directory', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  artifactStore.writeJson('plan/master-plan.json', validPlan());
  artifactStore.writeJson('tool-inventory.json', toolInventory);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    variables: {
      steps: {
        planner: {
          outputArtifact: path.join(runDir, 'plan/master-plan.json')
        },
        inventory: {
          outputArtifact: path.join(runDir, 'tool-inventory.json')
        }
      }
    }
  });
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute({
    ...planRuntimeStep,
    input: {
      planArtifact: '{{ steps.planner.outputArtifact }}',
      toolInventoryArtifact: '{{ steps.inventory.outputArtifact }}'
    }
  }, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

  assert.equal(result.status, 'succeeded');
  assert.equal(planRun?.status, 'succeeded');
  assert.equal(childCalls.length, 1);
});

test('planRuntime blocks when selected MCP tools have no tool-use evidence', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore, planWithMcpTool(), toolInventoryWithMcp);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');
  const audit = artifactStore.readJson<{ missingEvidence: string[] }>('audits/summarize/summarize-changes/audit.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'blocked');
  assert.equal(planRun?.tasks?.[0].status, 'blocked');
  assert.match((childCalls[0].input as { prompt: string }).prompt, /Advisory MCP tool evidence/);
  assert.deepEqual(audit?.missingEvidence, [
    'MCP tool-use evidence was not produced: tasks/summarize/summarize-changes/tool-use-evidence.json'
  ]);
});

test('planRuntime advances when selected MCP tools have valid tool-use evidence', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore, planWithMcpTool(), toolInventoryWithMcp);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    onChildStep: (_step, store) => {
      store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        claimedToolsUsed: ['mcp.user-github.list_pull_requests'],
        evidence: ['Listed pull requests and used the result IDs in the summary.']
      });
    }
  });
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');
  const audit = artifactStore.readJson<{ missingEvidence: string[]; risks: string[] }>('audits/summarize/summarize-changes/audit.json');

  assert.equal(result.status, 'succeeded');
  assert.equal(planRun?.status, 'succeeded');
  assert.deepEqual(audit?.missingEvidence, []);
  assert.deepEqual(audit?.risks, []);
});

test('planRuntime blocks malformed MCP tool-use evidence variants', async () => {
  const cases: Array<{
    name: string;
    writeEvidence: (store: ReturnType<typeof createArtifactStore>) => void;
    missingEvidence: string[];
    risks?: RegExp[];
  }> = [
    {
      name: 'invalid JSON',
      writeEvidence: store => store.writeText('tasks/summarize/summarize-changes/tool-use-evidence.json', '{not json'),
      missingEvidence: ['MCP tool-use evidence is not valid JSON: tasks/summarize/summarize-changes/tool-use-evidence.json'],
      risks: [/./]
    },
    {
      name: 'schema-invalid JSON',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        claimedToolsUsed: 'mcp.user-github.list_pull_requests',
        evidence: []
      }),
      missingEvidence: ['MCP tool-use evidence does not match tool-use-evidence@1: tasks/summarize/summarize-changes/tool-use-evidence.json'],
      risks: [/claimedToolsUsed must be a non-empty array/, /evidence must be a non-empty array/]
    },
    {
      name: 'missing selected tool claim',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        claimedToolsUsed: ['mcp.user-github.get_issue'],
        evidence: ['Looked at PRs but did not claim the selected MCP tool.']
      }),
      missingEvidence: ['MCP tool-use evidence did not claim selected tool: mcp.user-github.list_pull_requests']
    },
    {
      name: 'undeclared tool claim',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        claimedToolsUsed: ['mcp.user-github.list_pull_requests', 'mcp.user-slack.search'],
        evidence: ['Used an undeclared Slack search while summarizing GitHub data.']
      }),
      missingEvidence: [],
      risks: [/claimed undeclared tool: mcp\.user-slack\.search/]
    }
  ];

  for (const item of cases) {
    const runDir = tempRunDir();
    const schemaRegistry = createWorkflowSchemaRegistry();
    const artifactStore = createArtifactStore(runDir);
    writeBaseRuntimeInputs(artifactStore, planWithMcpTool(), toolInventoryWithMcp);
    const childCalls: WorkflowStep[] = [];
    const context = createContext(runDir, childCalls, {
      onChildStep: (_step, store) => item.writeEvidence(store)
    });
    const executor = new PlanRuntimeStepExecutor(schemaRegistry);

    const result = await executor.execute(planRuntimeStep, {
      stepRunId: `execute-plan-${item.name}`,
      definitionId: 'execute-plan',
      type: 'planRuntime',
      status: 'running'
    }, context);
    const planRun = artifactStore.readJson<PlanRun>('plan-run.json');
    const audit = artifactStore.readJson<{ missingEvidence: string[]; risks: string[] }>('audits/summarize/summarize-changes/audit.json');

    assert.equal(result.status, 'blocked', item.name);
    assert.equal(planRun?.status, 'blocked', item.name);
    assert.deepEqual(audit?.missingEvidence, item.missingEvidence, item.name);
    for (const risk of item.risks ?? []) {
      assert.equal(audit?.risks.some(value => risk.test(value)), true, item.name);
    }
  }
});

test('planRuntime blocks invalid planner JSON before task execution', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  artifactStore.writeText('plan/master-plan.json', '{not json');
  artifactStore.writeJson('tool-inventory.json', toolInventory);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');
  const validation = artifactStore.readJson<{ valid: boolean }>('plan/plan-validation.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'blocked');
  assert.equal(validation?.valid, false);
  assert.equal(childCalls.length, 0);
});

test('planRuntime blocks when required evidence is missing after task execution', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  artifactStore.writeJson('plan/master-plan.json', {
    ...validPlan(),
    stages: [
      {
        id: 'summarize',
        tasks: [
          {
            ...validPlan().stages[0].tasks[0],
            evidenceRequired: ['tasks/summarize/summarize-changes/missing.md']
          }
        ]
      }
    ]
  });
  artifactStore.writeJson('tool-inventory.json', toolInventory);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'blocked');
  assert.equal(planRun?.tasks?.[0].status, 'blocked');
  assert.equal(childCalls.length, 1);
});

test('planRuntime maps child executor terminal states to plan-run state', async () => {
  const cases: Array<{
    name: string;
    childResult: StepExecutionResult;
    expectedResultStatus: StepExecutionResult['status'];
    expectedPlanStatus: PlanRun['status'];
    expectedTaskStatus: string;
    expectedReason: RegExp;
  }> = [
    {
      name: 'failed',
      childResult: { status: 'failed', error: 'agent failed' },
      expectedResultStatus: 'failed',
      expectedPlanStatus: 'failed',
      expectedTaskStatus: 'failed',
      expectedReason: /agent failed/
    },
    {
      name: 'blocked',
      childResult: { status: 'blocked', blockedReason: 'needs human input' },
      expectedResultStatus: 'blocked',
      expectedPlanStatus: 'blocked',
      expectedTaskStatus: 'blocked',
      expectedReason: /needs human input/
    },
    {
      name: 'cancelled',
      childResult: { status: 'cancelled' },
      expectedResultStatus: 'cancelled',
      expectedPlanStatus: 'cancelled',
      expectedTaskStatus: 'cancelled',
      expectedReason: /did not succeed/
    }
  ];

  for (const item of cases) {
    const runDir = tempRunDir();
    const schemaRegistry = createWorkflowSchemaRegistry();
    const artifactStore = createArtifactStore(runDir);
    writeBaseRuntimeInputs(artifactStore);
    const childCalls: WorkflowStep[] = [];
    const context = createContext(runDir, childCalls, {
      childResult: item.childResult
    });
    const executor = new PlanRuntimeStepExecutor(schemaRegistry);

    const result = await executor.execute(planRuntimeStep, {
      stepRunId: `execute-plan-${item.name}`,
      definitionId: 'execute-plan',
      type: 'planRuntime',
      status: 'running'
    }, context);
    const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

    assert.equal(result.status, item.expectedResultStatus, item.name);
    assert.equal(planRun?.status, item.expectedPlanStatus, item.name);
    assert.equal(planRun?.tasks?.[0].status, item.expectedTaskStatus, item.name);
    assert.match(planRun?.blockReason ?? '', item.expectedReason, item.name);
    assert.equal(childCalls.length, 1, item.name);
  }
});

test('planRuntime maps confidence needsApproval to top-level blocked without succeeding task', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  const plan = validPlan();
  plan.stages[0].tasks[0].confidencePolicy.onFailure = 'needsApproval';
  plan.stages[0].tasks[0].evidenceRequired = ['tasks/summarize/summarize-changes/missing.md'];
  writeBaseRuntimeInputs(artifactStore, plan);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'needsApproval');
  assert.equal(planRun?.tasks?.[0].status, 'needsApproval');
  assert.equal(childCalls.length, 1);
});

test('planRuntime blocks approved high-risk plans before task execution in MVP', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore, {
    ...validPlan(),
    riskLevel: 'high',
    requiresApproval: true
  });
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls);
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'needsApproval');
  assert.equal(planRun?.stages?.[0].status, 'pending');
  assert.equal(planRun?.tasks?.[0].status, 'pending');
  assert.match(result.blockedReason ?? '', /requires human approval/);
  assert.equal(childCalls.length, 0);
});

test('planRuntime cancels before task execution when the workflow token is cancelled', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    tokenCancelled: true
  });
  const executor = new PlanRuntimeStepExecutor(schemaRegistry);

  const result = await executor.execute(planRuntimeStep, {
    stepRunId: 'execute-plan',
    definitionId: 'execute-plan',
    type: 'planRuntime',
    status: 'running'
  }, context);
  const planRun = artifactStore.readJson<PlanRun>('plan-run.json');

  assert.equal(result.status, 'cancelled');
  assert.equal(planRun?.status, 'cancelled');
  assert.equal(childCalls.length, 0);
});
