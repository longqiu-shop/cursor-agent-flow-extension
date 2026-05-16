/**
 * Cursor Agent Scheduler Extension
 * Main entry point for the extension
 */

import * as vscode from 'vscode';
import { SchedulerService } from './scheduler/schedulerService';
import { CommandRegistry } from './commands/commandRegistry';
import { SkillRegistry } from './commands/skillRegistry';
import { AgentRegistry } from './commands/agentRegistry';
import { WorkflowRegistry } from './workflow/workflowRegistry';
import { RunningWorkflowRegistry } from './workflow/runningWorkflowRegistry';
import { WorkflowSchemaRegistry } from './workflow/workflowSchemaRegistry';
import { createWorkflowSchemaRegistry } from './workflow/workflowSchemas';
import { CursorAgentSubmissionQueue } from './agent/cursorAgentSubmissionQueue';
import { StorageManager } from './storage/storageManager';
import { ScheduleTreeView } from './ui/scheduleTreeView';
import { ExtensionCommands } from './commands/extensionCommands';

let schedulerService: SchedulerService | undefined;
let commandRegistry: CommandRegistry | undefined;
let skillRegistry: SkillRegistry | undefined;
let agentRegistry: AgentRegistry | undefined;
let workflowRegistry: WorkflowRegistry | undefined;
let runningWorkflowRegistry: RunningWorkflowRegistry | undefined;
let workflowSchemaRegistry: WorkflowSchemaRegistry | undefined;
let submissionQueue: CursorAgentSubmissionQueue | undefined;
let storageManager: StorageManager | undefined;
let treeView: ScheduleTreeView | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Agent Scheduler extension is now active');

  // Initialize core services
  storageManager = new StorageManager(context.workspaceState);
  commandRegistry = new CommandRegistry();
  skillRegistry = new SkillRegistry();
  agentRegistry = new AgentRegistry();
  workflowSchemaRegistry = createWorkflowSchemaRegistry();
  workflowRegistry = new WorkflowRegistry(workflowSchemaRegistry);
  runningWorkflowRegistry = new RunningWorkflowRegistry();
  submissionQueue = new CursorAgentSubmissionQueue();
  schedulerService = new SchedulerService(
    storageManager,
    commandRegistry,
    skillRegistry,
    agentRegistry,
    workflowRegistry,
    runningWorkflowRegistry,
    submissionQueue,
    workflowSchemaRegistry
  );
  treeView = new ScheduleTreeView(storageManager, schedulerService, runningWorkflowRegistry);

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
    workflowRegistry,
    runningWorkflowRegistry,
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
    workflowRegistry?.reload();
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
  workflowRegistry?.onDidChange(() => treeView?.refresh());

  context.subscriptions.push(
    treeViewProvider,
    schedulerService,
    commandRegistry,
    skillRegistry!,
    agentRegistry!,
    workflowRegistry!,
    runningWorkflowRegistry!,
    schedulesFileWatcher
  );
}

export function deactivate() {
  schedulerService?.dispose();
  commandRegistry?.dispose();
  skillRegistry?.dispose();
  agentRegistry?.dispose();
  workflowRegistry?.dispose();
  runningWorkflowRegistry?.dispose();
}
