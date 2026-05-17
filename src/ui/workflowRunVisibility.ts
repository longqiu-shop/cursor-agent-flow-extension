import { WorkflowRun, WorkflowStatus } from '../types';

export const MAX_WORKFLOW_RUNS_IN_TREE = 50;

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'pending',
  'running',
  'blocked',
  'timedOut',
  'interrupted'
]);

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'succeeded',
  'failed',
  'timedOut',
  'interrupted',
  'cancelled'
]);

export function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return ACTIVE_WORKFLOW_STATUSES.has(status);
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function getWorkflowRunRerunGoal(run: WorkflowRun): string | undefined {
  const goal = run.trigger?.goal?.trim();
  return goal && goal.length > 0 ? goal : undefined;
}

export function isRerunnableWorkflowRun(run: WorkflowRun): boolean {
  return !isCancellableWorkflowStatus(run.status) && Boolean(getWorkflowRunRerunGoal(run));
}

export function isCancellableWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'blocked';
}

export function orderWorkflowRunsForTree(
  runs: WorkflowRun[],
  limit = MAX_WORKFLOW_RUNS_IN_TREE
): WorkflowRun[] {
  const sorted = [...runs].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const activeRuns = sorted.filter(run => isActiveWorkflowStatus(run.status));
  const terminalRuns = sorted.filter(run => !isActiveWorkflowStatus(run.status));
  return [...activeRuns, ...terminalRuns].slice(0, limit);
}
