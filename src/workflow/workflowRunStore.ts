import * as path from 'path';
import { WorkflowRun } from '../types';
import { fileExists, listSubdirectories, readJsonFile, resolveWorkspacePath, writeJsonFileAtomic } from '../utils/fileUtils';

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

export function loadWorkflowRuns(): WorkflowRun[] {
  const runsDir = resolveWorkspacePath(WORKFLOW_RUNS_DIR);
  const runs: WorkflowRun[] = [];

  for (const runId of listSubdirectories(runsDir)) {
    const run = loadWorkflowRun(path.join(runsDir, runId));
    if (run) {
      runs.push(run);
    }
  }

  return runs;
}
