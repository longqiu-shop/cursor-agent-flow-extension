/**
 * Cursor Agent Scheduler Extension
 * Main entry point for the extension
 */

import * as vscode from 'vscode';
import { SchedulerService } from './scheduler/schedulerService';
import { CommandRegistry } from './commands/commandRegistry';
import { SkillRegistry } from './commands/skillRegistry';
import { AgentRegistry } from './commands/agentRegistry';
import { StorageManager } from './storage/storageManager';
import { ScheduleTreeView } from './ui/scheduleTreeView';
import { ExtensionCommands } from './commands/extensionCommands';

let schedulerService: SchedulerService | undefined;
let commandRegistry: CommandRegistry | undefined;
let skillRegistry: SkillRegistry | undefined;
let agentRegistry: AgentRegistry | undefined;
let storageManager: StorageManager | undefined;
let treeView: ScheduleTreeView | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Agent Scheduler extension is now active');

  // Initialize core services
  storageManager = new StorageManager(context.workspaceState);
  commandRegistry = new CommandRegistry();
  skillRegistry = new SkillRegistry();
  agentRegistry = new AgentRegistry();
  schedulerService = new SchedulerService(
    storageManager,
    commandRegistry,
    skillRegistry,
    agentRegistry
  );
  treeView = new ScheduleTreeView(storageManager, schedulerService);

  // Register tree view
  const treeViewProvider = vscode.window.createTreeView('agentSchedules', {
    treeDataProvider: treeView,
    showCollapseAll: false
  });

  // Register commands
  const commands = new ExtensionCommands(
    storageManager,
    schedulerService,
    commandRegistry,
    skillRegistry,
    agentRegistry,
    treeView
  );
  commands.register(context);

  // Initialize scheduler
  schedulerService.initialize().catch(err => {
    console.error('Failed to initialize scheduler:', err);
    vscode.window.showErrorMessage(`Failed to initialize scheduler: ${err.message}`);
  });

  // Watch for workspace folder changes
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    commandRegistry?.reloadCommands();
    skillRegistry?.reload();
    agentRegistry?.reload();
    schedulerService?.reloadSchedules();
  });

  // Watch for changes to schedules file
  const schedulesFileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] || '', '.cursor/agent-schedules.json')
  );
  schedulesFileWatcher.onDidChange(() => {
    schedulerService?.reloadSchedules();
    treeView?.refresh();
  });
  schedulesFileWatcher.onDidCreate(() => {
    schedulerService?.reloadSchedules();
    treeView?.refresh();
  });
  schedulesFileWatcher.onDidDelete(() => {
    schedulerService?.reloadSchedules();
    treeView?.refresh();
  });

  // Listen for context registry changes to refresh tree view
  commandRegistry.onDidChange(() => treeView?.refresh());
  skillRegistry?.onDidChange(() => treeView?.refresh());
  agentRegistry?.onDidChange(() => treeView?.refresh());

  context.subscriptions.push(
    treeViewProvider,
    schedulerService,
    commandRegistry,
    skillRegistry!,
    agentRegistry!,
    schedulesFileWatcher
  );
}

export function deactivate() {
  schedulerService?.dispose();
  commandRegistry?.dispose();
  skillRegistry?.dispose();
  agentRegistry?.dispose();
}
