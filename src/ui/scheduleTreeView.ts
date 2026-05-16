/**
 * Tree view provider for agent schedules
 */

import * as vscode from 'vscode';
import { Schedule, WorkflowRun, WorkflowStepRun, WorkflowStatus, StepStatus } from '../types';
import { StorageManager } from '../storage/storageManager';
import { SchedulerService } from '../scheduler/schedulerService';
import { RunningWorkflowRegistry } from '../workflow/runningWorkflowRegistry';

export type ScheduleTreeElement = ScheduleTreeItem | WorkflowRunTreeItem | WorkflowStepTreeItem;

export class ScheduleTreeItem extends vscode.TreeItem {
  constructor(
    public readonly schedule: Schedule,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private schedulerService: SchedulerService
  ) {
    super(schedule.name, collapsibleState);

    this.tooltip = this.getTooltip();
    this.description = this.getDescription();
    this.contextValue = schedule.enabled ? 'schedule-enabled' : 'schedule-disabled';
    this.iconPath = this.getIcon();
  }

  private getIcon(): vscode.ThemeIcon {
    if (this.schedule.enabled) {
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    }
    return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.grey'));
  }

  private getDescription(): string {
    const parts: string[] = [];

    if (this.schedule.targetType === 'command' && this.schedule.commandRef) {
      parts.push(`Command: ${this.schedule.commandRef.commandId}`);
    } else if (this.schedule.targetType === 'workflow' && this.schedule.workflowRef) {
      parts.push(`Workflow: ${this.schedule.workflowRef.workflowId}`);
    } else if (this.schedule.commandRef) {
      parts.push(`${this.schedule.targetType}: ${this.schedule.commandRef.commandId}`);
    } else {
      parts.push('Prompt');
    }

    // Add next run time
    const nextRun = this.schedulerService.getNextRunTime(this.schedule.id);
    if (nextRun) {
      parts.push(`Next: ${nextRun.toLocaleString()}`);
    }

    return parts.join(' • ');
  }

  private getTooltip(): string {
    const lines: string[] = [
      `Schedule: ${this.schedule.name}`,
      `Status: ${this.schedule.enabled ? 'Enabled' : 'Disabled'}`,
      `Type: ${this.schedule.targetType}`,
      `Cron: ${this.schedule.cron}`,
      `Mode: ${this.schedule.executionMode}`
    ];

    if (this.schedule.targetType === 'command' && this.schedule.commandRef) {
      lines.push(`Command: ${this.schedule.commandRef.commandId}`);
      lines.push(`File: ${this.schedule.commandRef.filePath}`);
    }

    if (this.schedule.targetType === 'workflow' && this.schedule.workflowRef) {
      lines.push(`Workflow: ${this.schedule.workflowRef.workflowId}`);
      lines.push(`File: ${this.schedule.workflowRef.filePath}`);
    }

    const nextRun = this.schedulerService.getNextRunTime(this.schedule.id);
    if (nextRun) {
      lines.push(`Next Run: ${nextRun.toLocaleString()}`);
    }

    return lines.join('\n');
  }
}

export class WorkflowRunTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workflowRun: WorkflowRun,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(workflowRun.workflowName, collapsibleState);

    this.description = getWorkflowRunDescription(workflowRun);
    this.tooltip = getWorkflowRunTooltip(workflowRun);
    this.iconPath = getWorkflowStatusIcon(workflowRun.status);
    this.contextValue = isCancellableWorkflowStatus(workflowRun.status)
      ? 'workflow-run-cancellable'
      : 'workflow-run';
    this.command = {
      command: 'agentSchedules.inspectWorkflowRun',
      title: 'Inspect Workflow Run',
      arguments: [this]
    };
  }
}

export class WorkflowStepTreeItem extends vscode.TreeItem {
  constructor(
    public readonly workflowRun: WorkflowRun,
    public readonly stepRun: WorkflowStepRun,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(stepRun.title ?? stepRun.definitionId, collapsibleState);

    this.description = `${stepRun.status} • ${stepRun.type}`;
    this.tooltip = getWorkflowStepTooltip(stepRun);
    this.iconPath = getStepStatusIcon(stepRun.status);
    this.contextValue = 'workflow-step';
  }
}

export class ScheduleTreeView implements vscode.TreeDataProvider<ScheduleTreeElement> {
  private _onDidChangeTreeData: vscode.EventEmitter<ScheduleTreeElement | undefined | null | void> = new vscode.EventEmitter<ScheduleTreeElement | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ScheduleTreeElement | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(
    private storageManager: StorageManager,
    private schedulerService: SchedulerService,
    private runningWorkflowRegistry: RunningWorkflowRegistry
  ) {
    this.schedulerService.onDidChange(() => {
      this.refresh();
    });
    this.runningWorkflowRegistry.onDidChange(() => {
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ScheduleTreeElement): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ScheduleTreeElement): Promise<ScheduleTreeElement[]> {
    if (element instanceof ScheduleTreeItem) {
      return [];
    }

    if (element instanceof WorkflowRunTreeItem) {
      return element.workflowRun.steps.map(stepRun => new WorkflowStepTreeItem(
        element.workflowRun,
        stepRun,
        stepRun.childRuns?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      ));
    }

    if (element instanceof WorkflowStepTreeItem) {
      return (element.stepRun.childRuns ?? []).map(childRun => new WorkflowStepTreeItem(
        element.workflowRun,
        childRun,
        childRun.childRuns?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      ));
    }

    const schedules = await this.storageManager.loadSchedules();
    const activeRuns = this.runningWorkflowRegistry.listActive();
    return [
      ...activeRuns.map(run => new WorkflowRunTreeItem(run, vscode.TreeItemCollapsibleState.Collapsed)),
      ...schedules.map(schedule => new ScheduleTreeItem(schedule, vscode.TreeItemCollapsibleState.None, this.schedulerService))
    ];
  }

  /**
   * Get schedule from tree item
   */
  async getScheduleFromItem(item: ScheduleTreeItem): Promise<Schedule | undefined> {
    const schedules = await this.storageManager.loadSchedules();
    return schedules.find(s => s.id === item.schedule.id);
  }
}

function getWorkflowRunDescription(run: WorkflowRun): string {
  const parts: string[] = [run.status];
  if (run.currentStepId) {
    parts.push(`step: ${run.currentStepId}`);
  }
  parts.push(new Date(run.startedAt).toLocaleString());
  return parts.join(' • ');
}

function getWorkflowRunTooltip(run: WorkflowRun): string {
  const lines = [
    `Workflow: ${run.workflowName}`,
    `Workflow ID: ${run.workflowId}`,
    `Run ID: ${run.id}`,
    `Status: ${run.status}`,
    `Started: ${new Date(run.startedAt).toLocaleString()}`,
    `Run Directory: ${run.runDir}`
  ];

  if (run.currentStepId) {
    lines.push(`Current Step: ${run.currentStepId}`);
  }
  if (run.finishedAt) {
    lines.push(`Finished: ${new Date(run.finishedAt).toLocaleString()}`);
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`);
  }

  return lines.join('\n');
}

function getWorkflowStepTooltip(stepRun: WorkflowStepRun): string {
  const lines = [
    `Step: ${stepRun.definitionId}`,
    `Run ID: ${stepRun.stepRunId}`,
    `Type: ${stepRun.type}`,
    `Status: ${stepRun.status}`
  ];

  if (stepRun.startedAt) {
    lines.push(`Started: ${new Date(stepRun.startedAt).toLocaleString()}`);
  }
  if (stepRun.finishedAt) {
    lines.push(`Finished: ${new Date(stepRun.finishedAt).toLocaleString()}`);
  }
  if (stepRun.expectedArtifact) {
    lines.push(`Expected Artifact: ${stepRun.expectedArtifact}`);
  }
  if (stepRun.outputArtifact) {
    lines.push(`Output Artifact: ${stepRun.outputArtifact}`);
  }
  if (stepRun.blockedReason) {
    lines.push(`Blocked: ${stepRun.blockedReason}`);
  }
  if (stepRun.error) {
    lines.push(`Error: ${stepRun.error}`);
  }

  return lines.join('\n');
}

function getWorkflowStatusIcon(status: WorkflowStatus): vscode.ThemeIcon {
  switch (status) {
    case 'running':
    case 'pending':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
    case 'blocked':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'timedOut':
    case 'interrupted':
      return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.grey'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'succeeded':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  }
}

function getStepStatusIcon(status: StepStatus): vscode.ThemeIcon {
  return getWorkflowStatusIcon(status);
}

function isCancellableWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'blocked';
}
