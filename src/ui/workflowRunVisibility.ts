import { WorkflowRun, WorkflowStatus } from '../types';

export const MAX_WORKFLOW_RUNS_IN_TREE = 50;
const MAX_WORKFLOW_RUN_LABEL_LENGTH = 80;

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

export function getWorkflowRunDisplayName(run: WorkflowRun): string {
  const goal = normalizeDisplayText(run.trigger?.goal);
  if (goal) {
    return truncateDisplayText(goal, MAX_WORKFLOW_RUN_LABEL_LENGTH);
  }

  const requestId = normalizeDisplayText(run.trigger?.requestId);
  if (requestId) {
    return `${run.workflowName} (${truncateDisplayText(requestId, 32)})`;
  }

  return run.workflowName;
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

function normalizeDisplayText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function truncateDisplayText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
