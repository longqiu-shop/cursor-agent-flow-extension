import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowRun } from '../types';
import {
  createWorkflowRunDir,
  loadWorkflowRuns,
  saveWorkflowRunAtomic
} from './workflowRunStore';

function withWorkspace(t: TestContext): string {
  const workspace = fs.mkdtempSync(path.join(process.cwd(), 'tmp-workflow-runs-workspace-'));
  const previousWorkspace = process.env.AGENT_SCHEDULES_WORKSPACE;
  process.env.AGENT_SCHEDULES_WORKSPACE = workspace;
  t.after(() => {
    if (previousWorkspace === undefined) {
      delete process.env.AGENT_SCHEDULES_WORKSPACE;
    } else {
      process.env.AGENT_SCHEDULES_WORKSPACE = previousWorkspace;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}

function workflowRun(id: string, startedAt: string): WorkflowRun {
  return {
    id,
    workflowId: 'agentic-workflow-bootstrap',
    workflowName: 'Agentic Workflow Bootstrap',
    status: 'succeeded',
    runDir: createWorkflowRunDir(id),
    startedAt,
    finishedAt: startedAt,
    trigger: { goal: `Run ${id}` },
    steps: []
  };
}

test('loads persisted workflow runs from workspace agent run directories', t => {
  const workspace = withWorkspace(t);
  const first = workflowRun('run_first', '2026-05-16T01:00:00.000Z');
  const second = workflowRun('run_second', '2026-05-16T02:00:00.000Z');

  saveWorkflowRunAtomic(first);
  saveWorkflowRunAtomic(second);

  const emptyRunDir = path.join(workspace, '.cursor', 'agent-runs', 'empty');
  fs.mkdirSync(emptyRunDir, { recursive: true });

  const runs = loadWorkflowRuns();

  assert.deepEqual(new Set(runs.map(run => run.id)), new Set(['run_first', 'run_second']));
});
