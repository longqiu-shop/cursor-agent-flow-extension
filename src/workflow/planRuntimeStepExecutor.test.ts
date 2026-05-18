import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
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
  const context = createContext(runDir, childCalls, {
    onChildStep: (step, store) => {
      const input = step.input as { prompt?: string; promptArtifact?: string };
      if (input.promptArtifact) {
        store.writeText(input.promptArtifact, `FINAL WRAPPER\n${input.prompt ?? ''}`);
      }
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
  const audit = artifactStore.readJson('audits/summarize/summarize-changes/audit.json');
  const taskValidation = artifactStore.readJson<{ valid: boolean; checkedArtifacts: string[] }>('tasks/summarize/summarize-changes/validation.json');
  const provenance = artifactStore.readJson<{ promptSha256?: string; outputHashes: Array<{ path: string; sha256: string }> }>('tasks/summarize/summarize-changes/provenance.json');
  const finalPrompt = fs.readFileSync(path.join(runDir, 'tasks/summarize/summarize-changes/prompt.md'), 'utf-8');

  assert.equal(result.status, 'succeeded');
  assert.equal(planRun?.status, 'succeeded');
  assert.equal(planRun?.tasks?.[0].status, 'succeeded');
  assert.equal(childCalls.length, 1);
  assert.equal(childCalls[0].type, 'agent');
  assert.match((childCalls[0].input as { prompt: string }).prompt, /Task output contract/);
  assert.equal(audit !== undefined, true);
  assert.equal(fs.existsSync(path.join(runDir, 'tasks/summarize/summarize-changes/task-prompt.md')), true);
  assert.equal(taskValidation?.valid, true);
  assert.equal(fs.existsSync(path.join(runDir, 'tasks/summarize/summarize-changes/status.json')), false);
  assert.equal(provenance?.promptSha256, crypto.createHash('sha256').update(finalPrompt).digest('hex'));
  assert.equal(provenance?.outputHashes.some(item => item.path === 'tasks/summarize/summarize-changes/output.md'), true);
  assert.equal(fs.existsSync(path.join(runDir, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'trace.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'artifact-lineage.json')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'decision-log.md')), true);
});

test('planRuntime includes task-boundary metadata in child agent prompts', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  const plan = validPlan();
  plan.stages[0].tasks[0] = {
    ...plan.stages[0].tasks[0],
    role: 'verifier',
    taskBoundary: {
      role: 'verifier',
      maxAgentInvocations: 1,
      description: 'Verify the candidate output only'
    },
    dependsOn: ['candidate-review'],
    inputArtifacts: ['tasks/review/candidate-review/output.md'],
    outputPurpose: 'verification'
  };
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

  const prompt = (childCalls[0].input as { prompt: string }).prompt;
  assert.equal(result.status, 'succeeded');
  assert.match(prompt, /Role: verifier/);
  assert.match(prompt, /Output purpose: verification/);
  assert.match(prompt, /Max agent invocations: 1/);
  assert.match(prompt, /Depends on:\n- candidate-review/);
  assert.match(prompt, /Input artifacts:\n- tasks\/review\/candidate-review\/output\.md/);
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
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: ['mcp.user-github.list_pull_requests'],
        attemptedTools: [],
        unavailableTools: [],
        fallbackSources: [],
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

test('planRuntime advances when selected MCP tools are attempted with fallback evidence', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore, planWithMcpTool(), toolInventoryWithMcp);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    onChildStep: (_step, store) => {
      store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: [],
        attemptedTools: ['mcp.user-github.list_pull_requests'],
        unavailableTools: ['mcp.user-github.list_pull_requests'],
        fallbackSources: ['local git fetch', 'ReadFile'],
        evidence: ['GitHub MCP was unavailable; reviewed the PR from a local checkout instead.']
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
        selectedTools: [],
        usedTools: 'mcp.user-github.list_pull_requests',
        attemptedTools: [],
        unavailableTools: [],
        fallbackSources: [],
        evidence: []
      }),
      missingEvidence: ['MCP tool-use evidence does not match tool-use-evidence@1: tasks/summarize/summarize-changes/tool-use-evidence.json'],
      risks: [/selectedTools must be a non-empty array/, /usedTools must be an array/, /evidence must be a non-empty array/]
    },
    {
      name: 'missing selected tool accounting',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.get_issue'],
        usedTools: ['mcp.user-github.list_pull_requests'],
        attemptedTools: [],
        unavailableTools: [],
        fallbackSources: [],
        evidence: ['Looked at PRs but did not claim the selected MCP tool.']
      }),
      missingEvidence: ['MCP tool-use evidence did not include selected tool: mcp.user-github.list_pull_requests'],
      risks: [/included undeclared selected tool: mcp\.user-github\.get_issue/]
    },
    {
      name: 'unaccounted selected tool',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: [],
        attemptedTools: [],
        unavailableTools: [],
        fallbackSources: ['local git fetch'],
        evidence: ['Used local git but did not record what happened to the selected MCP tool.']
      }),
      missingEvidence: ['MCP tool-use evidence did not account for selected tool: mcp.user-github.list_pull_requests']
    },
    {
      name: 'missing fallback source',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: [],
        attemptedTools: ['mcp.user-github.list_pull_requests'],
        unavailableTools: [],
        fallbackSources: [],
        evidence: ['Tried the selected MCP tool and used another source, but did not name it.']
      }),
      missingEvidence: ['MCP fallback sources were not provided for selected tools that were not used']
    },
    {
      name: 'undeclared tool activity',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: ['mcp.user-github.list_pull_requests', 'mcp.user-slack.search'],
        attemptedTools: [],
        unavailableTools: [],
        fallbackSources: [],
        evidence: ['Used an undeclared Slack search while summarizing GitHub data.']
      }),
      missingEvidence: [],
      risks: [/reported activity for undeclared tool: mcp\.user-slack\.search/]
    },
    {
      name: 'unavailable without attempt',
      writeEvidence: store => store.writeJson('tasks/summarize/summarize-changes/tool-use-evidence.json', {
        schemaVersion: '1',
        selectedTools: ['mcp.user-github.list_pull_requests'],
        usedTools: [],
        attemptedTools: [],
        unavailableTools: ['mcp.user-github.list_pull_requests'],
        fallbackSources: ['local git fetch'],
        evidence: ['Marked the selected MCP tool unavailable without recording an attempt.']
      }),
      missingEvidence: [],
      risks: [/marked unavailable without attempted use: mcp\.user-github\.list_pull_requests/]
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

test('planRuntime blocks when a task proposes a plan amendment', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore);
  const beforePlanHash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(runDir, 'plan/master-plan.json')))
    .digest('hex');
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    onChildStep: (_step, store) => {
      store.writeJson('tasks/summarize/summarize-changes/plan-amendment-proposal.json', {
        schemaVersion: '1',
        reason: 'Need another verification task',
        triggeringEvidence: ['tasks/summarize/summarize-changes/output.md'],
        changeSummary: 'Add a verification task before completion',
        affectedStages: ['summarize'],
        riskChange: 'none',
        capabilityChanges: [],
        proposedDiff: {}
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
  const statusArtifact = artifactStore.readJson<{ status: string; reason: string }>('tasks/summarize/summarize-changes/status.json');
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf-8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as { type: string });
  const afterPlanHash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(runDir, 'plan/master-plan.json')))
    .digest('hex');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'blocked');
  assert.equal(statusArtifact?.status, 'blocked');
  assert.equal(beforePlanHash, afterPlanHash);
  assert.deepEqual(events.map(event => event.type).filter(type => type === 'plan.amendmentProposed' || type === 'planRuntime.blocked'), [
    'plan.amendmentProposed',
    'planRuntime.blocked'
  ]);
});

test('planRuntime rejects amendment proposal files outside the canonical path', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  writeBaseRuntimeInputs(artifactStore);
  const childCalls: WorkflowStep[] = [];
  const context = createContext(runDir, childCalls, {
    onChildStep: (_step, store) => {
      store.writeJson('tasks/summarize/summarize-changes/proposals/plan-amendment-proposal.json', {
        schemaVersion: '1',
        reason: 'Wrong path',
        triggeringEvidence: ['tasks/summarize/summarize-changes/output.md'],
        changeSummary: 'Move proposal',
        affectedStages: ['summarize'],
        riskChange: 'none',
        capabilityChanges: [],
        proposedDiff: {}
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
  const validation = artifactStore.readJson<{ errors: Array<{ code: string; path: string }> }>('tasks/summarize/summarize-changes/validation.json');

  assert.equal(result.status, 'blocked');
  assert.equal(planRun?.status, 'blocked');
  assert.match(planRun?.blockReason ?? '', /must be written only to tasks\/summarize\/summarize-changes\/plan-amendment-proposal\.json/);
  assert.deepEqual(validation?.errors.map(error => error.code), ['NON_CANONICAL_AMENDMENT_PROPOSAL']);
  assert.equal(validation?.errors[0].path, 'tasks/summarize/summarize-changes/proposals/plan-amendment-proposal.json');
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
