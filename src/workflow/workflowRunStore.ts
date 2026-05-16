import * as path from 'path';
import { WorkflowRun } from '../types';
import { fileExists, readJsonFile, resolveWorkspacePath, writeJsonFileAtomic } from '../utils/fileUtils';

const WORKFLOW_RUNS_DIR = '.cursor/agent-runs';
const WORKFLOW_RUN_STATE_FILE = 'workflow-run.json';

export function createWorkflowRunDir(runId: string): string {
  return resolveWorkspacePath(path.join(WORKFLOW_RUNS_DIR, runId));
}

export function getWorkflowRunStatePath(runDir: string): string {
  return path.join(runDir, WORKFLOW_RUN_STATE_FILE);
}

export function saveWorkflowRunAtomic(run: WorkflowRun): void {
  const statePath = getWorkflowRunStatePath(run.runDir);
  const success = writeJsonFileAtomic(statePath, run);
  if (!success) {
    throw new Error(`Failed to write workflow run state: ${statePath}`);
  }
}

export function loadWorkflowRun(runDir: string): WorkflowRun | undefined {
  const statePath = getWorkflowRunStatePath(runDir);
  if (!fileExists(statePath)) {
    return undefined;
  }
  return readJsonFile<WorkflowRun>(statePath);
}

export function markInterruptedForRecovery(run: WorkflowRun): WorkflowRun {
  if (run.status !== 'running') {
    return run;
  }

  const updatedSteps = run.steps.map(step => {
    if (step.status !== 'running') {
      return step;
    }
    return {
      ...step,
      status: 'interrupted' as const,
      finishedAt: new Date().toISOString(),
      childRuns: step.childRuns?.map(child => child.status === 'running'
        ? {
            ...child,
            status: 'interrupted' as const,
            finishedAt: new Date().toISOString()
          }
        : child)
    };
  });

  return {
    ...run,
    status: 'interrupted',
    finishedAt: new Date().toISOString(),
    steps: updatedSteps
  };
}
