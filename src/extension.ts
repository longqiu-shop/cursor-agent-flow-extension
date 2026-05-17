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
import { AgentChatTriggerService, AGENT_CHAT_REQUESTS_DIR } from './agentChat/agentChatTriggerService';

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
  const treeViewProvider = vscode.window.createTreeView('cursorAgentFlow', {
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

  const agentChatTriggerService = new AgentChatTriggerService(goal => commands.startAgenticWorkflowFromGoal(goal));
  const agentChatTriggerTimers = new Map<string, NodeJS.Timeout>();
  const queueAgentChatTrigger = (uri: vscode.Uri) => {
    if (uri.fsPath.endsWith('.result.json')) {
      return;
    }

    const existingTimer = agentChatTriggerTimers.get(uri.fsPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      agentChatTriggerTimers.delete(uri.fsPath);
      agentChatTriggerService.processRequestFile(uri.fsPath)
        .then(result => {
          if (result.status === 'started') {
            vscode.window.showInformationMessage(`Started agentic workflow run ${result.runId} from ${result.requestId}`);
          } else if (result.status === 'failed') {
            vscode.window.showErrorMessage(`Agent chat trigger ${result.requestId} failed: ${result.error}`);
          }
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to process agent chat trigger: ${message}`);
        });
    }, 200);
    agentChatTriggerTimers.set(uri.fsPath, timer);
  };

  const agentChatTriggerWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0] || '', `${AGENT_CHAT_REQUESTS_DIR}/*.json`)
  );
  agentChatTriggerWatcher.onDidCreate(queueAgentChatTrigger);
  agentChatTriggerWatcher.onDidChange(queueAgentChatTrigger);
  vscode.workspace.findFiles(`${AGENT_CHAT_REQUESTS_DIR}/*.json`).then(uris => {
    uris.forEach(queueAgentChatTrigger);
  }, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to scan agent chat trigger requests: ${message}`);
  });

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
    schedulesFileWatcher,
    agentChatTriggerWatcher,
    {
      dispose: () => {
        for (const timer of agentChatTriggerTimers.values()) {
          clearTimeout(timer);
        }
        agentChatTriggerTimers.clear();
      }
    }
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
