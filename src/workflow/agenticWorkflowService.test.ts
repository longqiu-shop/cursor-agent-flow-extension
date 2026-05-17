import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkflowDefinition, WorkflowRun, WorkflowRunTrigger, WorkflowStep } from '../types';
import {
  AGENTIC_BOOTSTRAP_WORKFLOW_ID,
  AGENTIC_READY_PLAN_WORKFLOW_ID,
  AgenticWorkflowService
} from './agenticWorkflowService';
import type { WorkflowRegistry } from './workflowRegistry';
import type { WorkflowRunner } from './workflowRunner';
import type { WorkflowRunnerFactory } from './workflowRunnerFactory';

function tempRunDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-service-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function workflow(id: string): WorkflowDefinition {
  return {
    id,
    name: id,
    filePath: `.cursor/workflows/${id}.json`,
    version: 1,
    steps: [
      {
        id: 'noop',
        type: 'readJson',
        input: { path: 'noop.json' }
      } satisfies WorkflowStep
    ]
  };
}

function createRegistry(workflows: WorkflowDefinition[]) {
  return {
    reloadCalls: 0,
    reload() {
      this.reloadCalls += 1;
    },
    get(_filePath: string, workflowId: string) {
      return workflows.find(candidate => candidate.id === workflowId);
    },
    getById(workflowId: string) {
      return workflows.find(candidate => candidate.id === workflowId);
    },
    getErrors() {
      return [];
    }
  };
}

function createFactory(t: TestContext) {
  const starts: Array<{ workflow: WorkflowDefinition; trigger?: WorkflowRunTrigger }> = [];
  return {
    starts,
    factory: {
      createRunner() {
        return {
          start(startedWorkflow: WorkflowDefinition, options: { trigger?: WorkflowRunTrigger }) {
            starts.push({ workflow: startedWorkflow, trigger: options.trigger });
            return {
              id: `run_${starts.length}`,
              workflowId: startedWorkflow.id,
              workflowName: startedWorkflow.name,
              trigger: options.trigger,
              status: 'running',
              runDir: tempRunDir(t),
              startedAt: '2026-05-16T00:00:00.000Z',
              steps: []
            } satisfies WorkflowRun;
          }
        } as unknown as WorkflowRunner;
      }
    } as WorkflowRunnerFactory
  };
}

test('startFromGoal rejects blank goals before workflow lookup', t => {
  const registry = createRegistry([workflow(AGENTIC_BOOTSTRAP_WORKFLOW_ID)]);
  const { factory } = createFactory(t);
  const service = new AgenticWorkflowService(registry as unknown as WorkflowRegistry, factory);

  assert.throws(
    () => service.startFromGoal({ goal: '   ', source: 'command' }),
    /goal must be non-empty/
  );
  assert.equal(registry.reloadCalls, 0);
});

test('startFromGoal returns workflow artifact run id and records trigger metadata', t => {
  const registry = createRegistry([workflow(AGENTIC_BOOTSTRAP_WORKFLOW_ID)]);
  const { factory, starts } = createFactory(t);
  const service = new AgenticWorkflowService(registry as unknown as WorkflowRegistry, factory);

  const runId = service.startFromGoal({
    goal: '  Summarize changes  ',
    source: 'agentChat',
    requestId: 'start-agentic-workflow-20260516230000'
  });

  assert.equal(runId, 'run_1');
  assert.equal(starts[0].workflow.id, AGENTIC_BOOTSTRAP_WORKFLOW_ID);
  assert.deepEqual(starts[0].trigger, {
    goal: 'Summarize changes',
    requestId: 'start-agentic-workflow-20260516230000',
    source: 'agentChat',
    startedAt: starts[0].trigger?.startedAt
  });
  assert.match(starts[0].trigger?.startedAt ?? '', /^\d{4}-/);
});

test('startFromPlanDocument starts the ready-plan workflow with plan path metadata', t => {
  const registry = createRegistry([workflow(AGENTIC_READY_PLAN_WORKFLOW_ID)]);
  const { factory, starts } = createFactory(t);
  const service = new AgenticWorkflowService(registry as unknown as WorkflowRegistry, factory);

  const runId = service.startFromPlanDocument({
    planPath: ' /tmp/ready-plan.md ',
    goal: ' Execute prepared plan ',
    source: 'command',
    requestId: 'start-agentic-workflow-20260516230001'
  });

  assert.equal(runId, 'run_1');
  assert.equal(starts[0].workflow.id, AGENTIC_READY_PLAN_WORKFLOW_ID);
  assert.equal(starts[0].trigger?.goal, 'Execute prepared plan');
  assert.equal(starts[0].trigger?.planPath, '/tmp/ready-plan.md');
  assert.equal(starts[0].trigger?.source, 'command');
  assert.equal(starts[0].trigger?.requestId, 'start-agentic-workflow-20260516230001');
});

test('missing bootstrap workflow produces a clear error', t => {
  const registry = createRegistry([]);
  const { factory } = createFactory(t);
  const service = new AgenticWorkflowService(registry as unknown as WorkflowRegistry, factory);

  assert.throws(
    () => service.startFromGoal({ goal: 'Summarize changes', source: 'command' }),
    /Workflow not found: agentic-workflow-bootstrap/
  );
});
