import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanRuntimeStepExecutor } from './planRuntimeStepExecutor';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import type { MasterPlan, PlanRun, ToolInventory } from './planSchemas';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { WorkflowExecutionContext } from './workflowRunner';
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

function createContext(runDir: string, childCalls: WorkflowStep[], variables: WorkflowVariables = {}): WorkflowExecutionContext {
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
      ...variables
    },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as WorkflowExecutionContext['token'],
    executeChildStep: async step => {
      childCalls.push(step);
      const outputPath = step.output
        ? artifactStore.writeText(step.output.path, '# Summary\n', {})
        : undefined;
      const stepRun: WorkflowStepRun = {
        stepRunId: `child-${childCalls.length}`,
        definitionId: step.id,
        type: step.type,
        status: 'succeeded',
        outputArtifact: outputPath
      };
      return {
        stepRun,
        result: {
          status: 'succeeded',
          outputArtifact: outputPath
        }
      };
    }
  };
}

test('planRuntime executes a valid one-task plan through audit and confidence', async () => {
  const runDir = tempRunDir();
  const schemaRegistry = createWorkflowSchemaRegistry();
  const artifactStore = createArtifactStore(runDir);
  artifactStore.writeJson('plan/master-plan.json', validPlan());
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
    steps: {
      planner: {
        outputArtifact: path.join(runDir, 'plan/master-plan.json')
      },
      inventory: {
        outputArtifact: path.join(runDir, 'tool-inventory.json')
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
