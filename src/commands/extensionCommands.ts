/**
 * Extension command handlers
 */

import * as vscode from 'vscode';
import { StorageManager } from '../storage/storageManager';
import { SchedulerService } from '../scheduler/schedulerService';
import { CommandRegistry } from './commandRegistry';
import { SkillRegistry } from './skillRegistry';
import { AgentRegistry } from './agentRegistry';
import { WorkflowRegistry } from '../workflow/workflowRegistry';
import { RunningWorkflowRegistry } from '../workflow/runningWorkflowRegistry';
import { Schedule, WorkflowRun } from '../types';
import { ScheduleTreeView, ScheduleTreeItem, WorkflowRunTreeItem, WorkflowStepTreeItem } from '../ui/scheduleTreeView';
import { ScheduleEditorWebview } from '../ui/scheduleEditorWebview';
import { RunHistoryView } from '../ui/runHistoryView';
import { WorkflowRunDetailsView } from '../ui/workflowRunDetailsView';
import {
  getWorkflowRunRerunGoal,
  orderWorkflowRunsForTree
} from '../ui/workflowRunVisibility';
import { CursorAgentExecutor } from '../agent/keyboardAgent';

const AGENTIC_BOOTSTRAP_WORKFLOW_FILE = '.cursor/workflows/agentic-workflow-bootstrap.json';
const AGENTIC_BOOTSTRAP_WORKFLOW_ID = 'agentic-workflow-bootstrap';

export class ExtensionCommands {
  private scheduleEditor: ScheduleEditorWebview;
  private runHistoryView: RunHistoryView;
  private workflowRunDetailsView: WorkflowRunDetailsView;
  private agentExecutor: CursorAgentExecutor;

  constructor(
    private storageManager: StorageManager,
    private schedulerService: SchedulerService,
    private commandRegistry: CommandRegistry,
    private skillRegistry: SkillRegistry,
    private agentRegistry: AgentRegistry,
    private workflowRegistry: WorkflowRegistry,
    private runningWorkflowRegistry: RunningWorkflowRegistry,
    private treeView: ScheduleTreeView
  ) {
    this.scheduleEditor = new ScheduleEditorWebview(
      commandRegistry,
      skillRegistry,
      agentRegistry,
      workflowRegistry,
      schedulerService,
      storageManager
    );
    this.runHistoryView = new RunHistoryView(storageManager);
    this.workflowRunDetailsView = new WorkflowRunDetailsView();
    this.agentExecutor = new CursorAgentExecutor();
  }

  register(context: vscode.ExtensionContext): void {
    const commands = [
      vscode.commands.registerCommand('cursorAgentFlow.add', () => this.addSchedule()),
      vscode.commands.registerCommand('cursorAgentFlow.edit', (item?: ScheduleTreeItem) => this.editSchedule(item)),
      vscode.commands.registerCommand('cursorAgentFlow.runNow', (item?: ScheduleTreeItem) => this.runNow(item)),
      vscode.commands.registerCommand('cursorAgentFlow.enable', (item: ScheduleTreeItem) => this.enableSchedule(item)),
      vscode.commands.registerCommand('cursorAgentFlow.disable', (item: ScheduleTreeItem) => this.disableSchedule(item)),
      vscode.commands.registerCommand('cursorAgentFlow.viewRuns', (item?: ScheduleTreeItem) => this.viewRuns(item)),
      vscode.commands.registerCommand('cursorAgentFlow.viewWorkflowRuns', () => this.viewWorkflowRuns()),
      vscode.commands.registerCommand('cursorAgentFlow.inspectWorkflowRun', (item?: WorkflowRunTreeItem | WorkflowStepTreeItem) => this.inspectWorkflowRun(item)),
      vscode.commands.registerCommand('cursorAgentFlow.openWorkflowRunFolder', (item?: WorkflowRunTreeItem | WorkflowStepTreeItem) => this.openWorkflowRunFolder(item)),
      vscode.commands.registerCommand('cursorAgentFlow.cancelWorkflowRun', (item?: WorkflowRunTreeItem | WorkflowStepTreeItem) => this.cancelWorkflowRun(item)),
      vscode.commands.registerCommand('cursorAgentFlow.rerunWorkflowRun', (item?: WorkflowRunTreeItem | WorkflowStepTreeItem) => this.rerunWorkflowRun(item)),
      vscode.commands.registerCommand('cursorAgentFlow.startAgenticWorkflow', (goal?: string) => this.startAgenticWorkflow(goal)),
      vscode.commands.registerCommand('cursorAgentFlow.reloadCommands', () => this.reloadCommands()),
      vscode.commands.registerCommand('cursorAgentFlow.testExecution', () => this.testExecution()),
    ];

    commands.forEach(cmd => context.subscriptions.push(cmd));
  }

  private async addSchedule(): Promise<void> {
    this.scheduleEditor.openNew();
  }

  private async editSchedule(item?: ScheduleTreeItem): Promise<void> {
    if (!item) {
      const schedules = await this.storageManager.loadSchedules();
      const scheduleNames = schedules.map(s => s.name);
      const selected = await vscode.window.showQuickPick(scheduleNames, {
        placeHolder: 'Select a schedule to edit'
      });
      
      if (!selected) return;

      const schedule = schedules.find(s => s.name === selected);
      if (schedule) {
        this.scheduleEditor.open(schedule);
      }
      return;
    }

    const schedule = await this.treeView.getScheduleFromItem(item);
    if (schedule) {
      this.scheduleEditor.open(schedule);
    }
  }

  private async runNow(item?: ScheduleTreeItem): Promise<void> {
    const schedule = item
      ? await this.treeView.getScheduleFromItem(item)
      : await this.pickSchedule('Select a schedule to run');
    if (!schedule) {
      vscode.window.showErrorMessage('Schedule not found');
      return;
    }

    try {
      console.log('[ExtensionCommands] Run Now selected schedule:', {
        id: schedule.id,
        name: schedule.name,
        targetType: schedule.targetType,
        executionMode: schedule.executionMode,
        commandRef: schedule.commandRef,
        workflowRef: schedule.workflowRef,
        hasPromptTemplate: Boolean(schedule.promptTemplate)
      });
      await this.schedulerService.runSchedule(schedule.id);
      vscode.window.showInformationMessage(`Running schedule "${schedule.name}"...`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to run schedule: ${message}`);
    }
  }

  private async startAgenticWorkflow(goalArg?: string): Promise<void> {
    const goal = goalArg ?? await vscode.window.showInputBox({
      prompt: 'What should the agentic workflow accomplish?',
      placeHolder: 'Example: Summarize today\'s git changes',
      ignoreFocusOut: true
    });
    if (!goal || goal.trim().length === 0) {
      return;
    }

    const trimmedGoal = goal.trim();

    try {
      const runId = await this.startAgenticWorkflowFromGoal(trimmedGoal);
      vscode.window.showInformationMessage(`Started agentic workflow run ${runId} for: ${trimmedGoal}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to start agentic workflow: ${message}`);
    }
  }

  async startAgenticWorkflowFromGoal(goal: string, requestId?: string): Promise<string> {
    const trimmedGoal = goal.trim();
    if (trimmedGoal.length === 0) {
      throw new Error('Agentic workflow goal must be non-empty');
    }

    const schedule = this.createAgenticWorkflowSchedule(trimmedGoal, requestId);
    this.workflowRegistry.reload();
    const workflow = this.workflowRegistry.get(
      AGENTIC_BOOTSTRAP_WORKFLOW_FILE,
      AGENTIC_BOOTSTRAP_WORKFLOW_ID
    );
    if (!workflow) {
      const errors = this.workflowRegistry.getErrors()
        .map(error => `${error.filePath}: ${error.errors.join('; ')}`)
        .join('\n');
      throw new Error(errors || `Workflow not found: ${AGENTIC_BOOTSTRAP_WORKFLOW_ID}`);
    }

    const runId = await this.schedulerService.runScheduleDirect(schedule);
    this.treeView.refresh();
    return runId;
  }

  private createAgenticWorkflowSchedule(goal: string, requestId?: string): Schedule {
    return {
      id: `agentic-workflow-${Date.now()}`,
      name: `Agentic Workflow: ${goal.slice(0, 60)}`,
      enabled: false,
      cron: '0 0 1 1 *',
      targetType: 'workflow',
      workflowRef: {
        filePath: AGENTIC_BOOTSTRAP_WORKFLOW_FILE,
        workflowId: AGENTIC_BOOTSTRAP_WORKFLOW_ID
      },
      promptTemplate: goal,
      executionMode: 'ide',
      outputConfig: {
        type: 'none'
      },
      constraints: {
        maxRuntime: 1800
      },
      metadata: {
        description: 'Ad-hoc agentic workflow run from the command bridge',
        requestId
      }
    };
  }

  private async enableSchedule(item: ScheduleTreeItem): Promise<void> {
    const schedule = await this.treeView.getScheduleFromItem(item);
    if (!schedule) {
      vscode.window.showErrorMessage('Schedule not found');
      return;
    }

    try {
      await this.schedulerService.enableSchedule(schedule.id);
      this.treeView.refresh();
      vscode.window.showInformationMessage(`Schedule "${schedule.name}" enabled`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to enable schedule: ${message}`);
    }
  }

  private async disableSchedule(item: ScheduleTreeItem): Promise<void> {
    const schedule = await this.treeView.getScheduleFromItem(item);
    if (!schedule) {
      vscode.window.showErrorMessage('Schedule not found');
      return;
    }

    try {
      await this.schedulerService.disableSchedule(schedule.id);
      this.treeView.refresh();
      vscode.window.showInformationMessage(`Schedule "${schedule.name}" disabled`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to disable schedule: ${message}`);
    }
  }

  private async viewRuns(item?: ScheduleTreeItem): Promise<void> {
    let scheduleId: string | undefined;
    
    if (item) {
      const schedule = await this.treeView.getScheduleFromItem(item);
      if (schedule) {
        scheduleId = schedule.id;
      }
    }

    const records = scheduleId 
      ? this.storageManager.getRunHistoryForSchedule(scheduleId)
      : this.storageManager.getRunHistory();

    if (records.length === 0) {
      vscode.window.showInformationMessage('No run history available');
      return;
    }

    const mostRecent = records[0];
    this.runHistoryView.showRunDetails(mostRecent);

    if (records.length > 1) {
      const items = records.map((r) => ({
        label: `${r.scheduleName} - ${new Date(r.startedAt).toLocaleString()}`,
        description: r.status,
        detail: r.summary || r.error || '',
        runRecord: r
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a run to view details'
      });

      if (selected) {
        this.runHistoryView.showRunDetails(selected.runRecord);
      }
    }
  }

  private async pickSchedule(placeHolder: string): Promise<import('../types').Schedule | undefined> {
    const schedules = await this.storageManager.loadSchedules();
    if (schedules.length === 0) {
      vscode.window.showInformationMessage('No schedules available');
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(schedules.map(schedule => ({
      label: schedule.name,
      description: schedule.targetType,
      detail: schedule.workflowRef?.workflowId ?? schedule.commandRef?.commandId ?? schedule.promptTemplate ?? '',
      schedule
    })), { placeHolder });

    return selected?.schedule;
  }

  private async viewWorkflowRuns(): Promise<void> {
    const run = await this.pickWorkflowRun('Select a workflow run to inspect');
    if (run) {
      this.workflowRunDetailsView.show(run);
    }
  }

  private async inspectWorkflowRun(item?: WorkflowRunTreeItem | WorkflowStepTreeItem): Promise<void> {
    const run = this.getWorkflowRunFromItem(item) ?? await this.pickWorkflowRun('Select a workflow run to inspect');
    if (run) {
      this.workflowRunDetailsView.show(run);
    }
  }

  private async openWorkflowRunFolder(item?: WorkflowRunTreeItem | WorkflowStepTreeItem): Promise<void> {
    const run = this.getWorkflowRunFromItem(item) ?? await this.pickWorkflowRun('Select a workflow run');
    if (!run) {
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(run.runDir));
  }

  private async cancelWorkflowRun(item?: WorkflowRunTreeItem | WorkflowStepTreeItem): Promise<void> {
    const run = this.getWorkflowRunFromItem(item) ?? await this.pickWorkflowRun('Select a workflow run to cancel', true);
    if (!run) {
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Cancel workflow run "${run.workflowName}"?`,
      { modal: true },
      'Cancel Workflow'
    );
    if (confirmed !== 'Cancel Workflow') {
      return;
    }

    const cancelled = this.schedulerService.cancelWorkflowRun(run.id);
    if (cancelled) {
      this.treeView.refresh();
      vscode.window.showInformationMessage(`Workflow run "${run.workflowName}" cancelled`);
    } else {
      vscode.window.showWarningMessage(`Workflow run "${run.workflowName}" is no longer cancellable`);
    }
  }

  private async rerunWorkflowRun(item?: WorkflowRunTreeItem | WorkflowStepTreeItem): Promise<void> {
    const run = this.getWorkflowRunFromItem(item) ?? await this.pickWorkflowRun('Select a workflow run to rerun');
    if (!run) {
      return;
    }

    const goal = getWorkflowRunRerunGoal(run);
    if (!goal) {
      vscode.window.showWarningMessage(`Workflow run "${run.workflowName}" does not have rerun metadata`);
      return;
    }

    if (run.workflowId !== AGENTIC_BOOTSTRAP_WORKFLOW_ID) {
      vscode.window.showWarningMessage(`Workflow run "${run.workflowName}" cannot be rerun from this view yet`);
      return;
    }

    try {
      const runId = await this.startAgenticWorkflowFromGoal(goal);
      vscode.window.showInformationMessage(`Reran workflow as ${runId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to rerun workflow: ${message}`);
    }
  }

  private async reloadCommands(): Promise<void> {
    this.commandRegistry.reloadCommands();
    this.skillRegistry.reload();
    this.agentRegistry.reload();
    this.workflowRegistry.reload();
    vscode.window.showInformationMessage('Commands, skills, agents, and workflows reloaded');
  }

  private getWorkflowRunFromItem(item?: WorkflowRunTreeItem | WorkflowStepTreeItem): WorkflowRun | undefined {
    if (item instanceof WorkflowRunTreeItem) {
      return this.runningWorkflowRegistry.get(item.workflowRun.id) ?? item.workflowRun;
    }
    if (item instanceof WorkflowStepTreeItem) {
      return this.runningWorkflowRegistry.get(item.workflowRun.id) ?? item.workflowRun;
    }
    return undefined;
  }

  private async pickWorkflowRun(placeHolder: string, activeOnly = false): Promise<WorkflowRun | undefined> {
    const runs = activeOnly
      ? this.runningWorkflowRegistry.listActive()
      : orderWorkflowRunsForTree(this.runningWorkflowRegistry.listAll());
    if (runs.length === 0) {
      vscode.window.showInformationMessage(activeOnly ? 'No active workflow runs' : 'No workflow runs');
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(runs.map(run => ({
      label: run.workflowName,
      description: run.status,
      detail: `${new Date(run.startedAt).toLocaleString()} • ${run.id}`,
      run
    })), { placeHolder });

    return selected?.run;
  }

  /**
   * Test agent execution with a sample prompt
   */
  private async testExecution(): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Enter test prompt',
      value: `Create a file called test-${Date.now()}.md with "Hello World"`,
      placeHolder: 'Enter a prompt to test agent execution'
    });

    if (!prompt) return;

    vscode.window.showInformationMessage('Starting agent execution...');
    this.agentExecutor.showOutput();
    
    const result = await this.agentExecutor.executePrompt(prompt);
    
    if (result.success) {
      vscode.window.showInformationMessage(
        `✅ Execution successful! ${result.filesCreated?.length || 0} file(s) created.`
      );
    } else {
      vscode.window.showWarningMessage(`⚠️ ${result.error || 'Execution failed'}`);
    }
  }
}
