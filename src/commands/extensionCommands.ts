/**
 * Extension command handlers
 */

import * as vscode from 'vscode';
import { StorageManager } from '../storage/storageManager';
import { SchedulerService } from '../scheduler/schedulerService';
import { CommandRegistry } from './commandRegistry';
import { SkillRegistry } from './skillRegistry';
import { AgentRegistry } from './agentRegistry';
import { ScheduleTreeView, ScheduleTreeItem } from '../ui/scheduleTreeView';
import { ScheduleEditorWebview } from '../ui/scheduleEditorWebview';
import { RunHistoryView } from '../ui/runHistoryView';
import { CursorAgentExecutor } from '../agent/keyboardAgent';

export class ExtensionCommands {
  private scheduleEditor: ScheduleEditorWebview;
  private runHistoryView: RunHistoryView;
  private agentExecutor: CursorAgentExecutor;

  constructor(
    private storageManager: StorageManager,
    private schedulerService: SchedulerService,
    private commandRegistry: CommandRegistry,
    private skillRegistry: SkillRegistry,
    private agentRegistry: AgentRegistry,
    private treeView: ScheduleTreeView
  ) {
    this.scheduleEditor = new ScheduleEditorWebview(
      commandRegistry,
      skillRegistry,
      agentRegistry,
      schedulerService,
      storageManager
    );
    this.runHistoryView = new RunHistoryView(storageManager);
    this.agentExecutor = new CursorAgentExecutor();
  }

  register(context: vscode.ExtensionContext): void {
    const commands = [
      vscode.commands.registerCommand('agentSchedules.add', () => this.addSchedule()),
      vscode.commands.registerCommand('agentSchedules.edit', (item?: ScheduleTreeItem) => this.editSchedule(item)),
      vscode.commands.registerCommand('agentSchedules.runNow', (item: ScheduleTreeItem) => this.runNow(item)),
      vscode.commands.registerCommand('agentSchedules.enable', (item: ScheduleTreeItem) => this.enableSchedule(item)),
      vscode.commands.registerCommand('agentSchedules.disable', (item: ScheduleTreeItem) => this.disableSchedule(item)),
      vscode.commands.registerCommand('agentSchedules.viewRuns', (item?: ScheduleTreeItem) => this.viewRuns(item)),
      vscode.commands.registerCommand('agentSchedules.reloadCommands', () => this.reloadCommands()),
      vscode.commands.registerCommand('agentSchedules.testExecution', () => this.testExecution()),
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

  private async runNow(item: ScheduleTreeItem): Promise<void> {
    const schedule = await this.treeView.getScheduleFromItem(item);
    if (!schedule) {
      vscode.window.showErrorMessage('Schedule not found');
      return;
    }

    try {
      await this.schedulerService.runSchedule(schedule.id);
      vscode.window.showInformationMessage(`Running schedule "${schedule.name}"...`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to run schedule: ${message}`);
    }
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

  private async reloadCommands(): Promise<void> {
    this.commandRegistry.reloadCommands();
    this.skillRegistry.reload();
    this.agentRegistry.reload();
    vscode.window.showInformationMessage('Commands, skills, and agents reloaded');
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
