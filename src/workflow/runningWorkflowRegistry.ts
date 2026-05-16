import * as vscode from 'vscode';
import * as path from 'path';
import { WorkflowRun } from '../types';
import { directoryExists, listSubdirectories, resolveWorkspacePath } from '../utils/fileUtils';
import { loadWorkflowRun, markInterruptedForRecovery, saveWorkflowRunAtomic } from './workflowRunStore';

const WORKFLOW_RUNS_DIR = '.cursor/agent-runs';
const ACTIVE_STATUSES = new Set(['pending', 'running', 'blocked', 'timedOut', 'interrupted']);

export class RunningWorkflowRegistry implements vscode.Disposable {
  private runs = new Map<string, WorkflowRun>();
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    this.loadPersistedRuns();
  }

  add(run: WorkflowRun): void {
    this.runs.set(run.id, run);
    saveWorkflowRunAtomic(run);
    this.onDidChangeEmitter.fire();
  }

  update(run: WorkflowRun): void {
    this.runs.set(run.id, run);
    saveWorkflowRunAtomic(run);
    this.onDidChangeEmitter.fire();
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  listActive(): WorkflowRun[] {
    return this.sortNewestFirst(Array.from(this.runs.values()).filter(run => ACTIVE_STATUSES.has(run.status)));
  }

  listAll(): WorkflowRun[] {
    return this.sortNewestFirst(Array.from(this.runs.values()));
  }

  markCancelled(runId: string, reason = 'Workflow cancelled by user'): boolean {
    const run = this.runs.get(runId);
    if (!run || !ACTIVE_STATUSES.has(run.status)) {
      return false;
    }

    run.status = 'cancelled';
    run.error = reason;
    run.finishedAt = new Date().toISOString();
    run.steps = run.steps.map(step => this.markStepCancelled(step, reason, run.finishedAt!));
    this.update(run);
    return true;
  }

  private sortNewestFirst(runs: WorkflowRun[]): WorkflowRun[] {
    return runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  private markStepCancelled(step: WorkflowRun['steps'][number], reason: string, finishedAt: string): WorkflowRun['steps'][number] {
    if (step.status !== 'pending' && step.status !== 'running' && step.status !== 'blocked') {
      return {
        ...step,
        childRuns: step.childRuns?.map(child => this.markStepCancelled(child, reason, finishedAt))
      };
    }

    return {
      ...step,
      status: 'cancelled',
      error: reason,
      finishedAt: step.finishedAt ?? finishedAt,
      childRuns: step.childRuns?.map(child => this.markStepCancelled(child, reason, finishedAt))
    };
  }

  private loadPersistedRuns(): void {
    const runsDir = resolveWorkspacePath(WORKFLOW_RUNS_DIR);
    if (!directoryExists(runsDir)) {
      return;
    }

    for (const dirName of listSubdirectories(runsDir)) {
      const runDir = path.join(runsDir, dirName);
      const run = loadWorkflowRun(runDir);
      if (!run) {
        continue;
      }

      const recovered = markInterruptedForRecovery(run);
      if (recovered !== run) {
        saveWorkflowRunAtomic(recovered);
      }
      this.runs.set(recovered.id, recovered);
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
