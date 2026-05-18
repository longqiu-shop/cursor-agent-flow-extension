import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRun, WorkflowStatus } from '../types';
import {
  getWorkflowRunDisplayName,
  getWorkflowRunRerunGoal,
  isRerunnableWorkflowRun,
  orderWorkflowRunsForTree
} from './workflowRunVisibility';

function workflowRun(id: string, status: WorkflowStatus, startedAt: string, goal?: string): WorkflowRun {
  return {
    id,
    workflowId: 'agentic-workflow-bootstrap',
    workflowName: id,
    status,
    runDir: `/tmp/${id}`,
    startedAt,
    trigger: goal ? { goal } : undefined,
    steps: []
  };
}

test('orders active workflow runs before recent terminal runs', () => {
  const runs = [
    workflowRun('succeeded-newer', 'succeeded', '2026-05-16T03:00:00.000Z'),
    workflowRun('running-older', 'running', '2026-05-16T01:00:00.000Z'),
    workflowRun('failed-middle', 'failed', '2026-05-16T02:00:00.000Z')
  ];

  assert.deepEqual(orderWorkflowRunsForTree(runs).map(run => run.id), [
    'running-older',
    'succeeded-newer',
    'failed-middle'
  ]);
});

test('limits workflow runs shown in the tree', () => {
  const runs = [
    workflowRun('running', 'running', '2026-05-16T01:00:00.000Z'),
    workflowRun('failed', 'failed', '2026-05-16T02:00:00.000Z'),
    workflowRun('succeeded', 'succeeded', '2026-05-16T03:00:00.000Z')
  ];

  assert.deepEqual(orderWorkflowRunsForTree(runs, 2).map(run => run.id), [
    'running',
    'succeeded'
  ]);
});

test('reruns only non-cancellable workflow runs with a persisted trigger goal', () => {
  assert.equal(isRerunnableWorkflowRun(workflowRun('running', 'running', '2026-05-16T01:00:00.000Z', 'Do work')), false);
  assert.equal(isRerunnableWorkflowRun(workflowRun('failed', 'failed', '2026-05-16T01:00:00.000Z')), false);
  assert.equal(isRerunnableWorkflowRun(workflowRun('failed', 'failed', '2026-05-16T01:00:00.000Z', ' Do work ')), true);
  assert.equal(getWorkflowRunRerunGoal(workflowRun('failed', 'failed', '2026-05-16T01:00:00.000Z', ' Do work ')), 'Do work');
});

test('uses trigger goal as workflow run display name', () => {
  const run = workflowRun('Agentic Workflow Bootstrap', 'running', '2026-05-16T01:00:00.000Z', '  Fix the duplicate workflow labels\nand restore history  ');

  assert.equal(getWorkflowRunDisplayName(run), 'Fix the duplicate workflow labels and restore history');
});

test('falls back to workflow name and request id when no goal is available', () => {
  const run = workflowRun('Agentic Workflow Bootstrap', 'running', '2026-05-16T01:00:00.000Z');
  run.workflowName = 'Agentic Workflow Bootstrap';
  run.trigger = { requestId: 'start-agentic-workflow-20260517000000' };

  assert.equal(
    getWorkflowRunDisplayName(run),
    'Agentic Workflow Bootstrap (start-agentic-workflow-202605...)'
  );
});
