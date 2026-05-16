import * as vscode from 'vscode';
import * as path from 'path';
import { WorkflowDefinition } from '../types';
import { CURSOR_CONTEXT_DIRS, directoryExists, getAllWorkspaceFolders, listFiles, readJsonFile } from '../utils/fileUtils';
import { validateWorkflowDefinition } from './workflowValidation';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

const WORKFLOWS_DIR = CURSOR_CONTEXT_DIRS.WORKFLOWS;

interface WorkflowRegistryError {
  filePath: string;
  errors: string[];
}

export class WorkflowRegistry implements vscode.Disposable {
  private workflowsByRef: Map<string, WorkflowDefinition> = new Map();
  private workflowIds: Map<string, string> = new Map();
  private errors: WorkflowRegistryError[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly schemaRegistry: WorkflowSchemaRegistry = createWorkflowSchemaRegistry()) {
    this.reload();
    this.watch();
  }

  reload(): void {
    this.workflowsByRef.clear();
    this.workflowIds.clear();
    this.errors = [];

    const workflowDirectories = this.getWorkflowDirectories();
    console.log(`[WorkflowRegistry] Reloading workflows from ${workflowDirectories.length} directorie(s): ${workflowDirectories.join(', ')}`);
    for (const workflowsDir of workflowDirectories) {
      for (const filePath of listFiles(workflowsDir, '.json')) {
        this.loadWorkflowFile(filePath);
      }
    }
    console.log(
      `[WorkflowRegistry] Loaded ${this.workflowsByRef.size} workflow(s); ` +
      `errors=${this.errors.length}`
    );

    this.onDidChangeEmitter.fire();
  }

  get(filePath: string, workflowId: string): WorkflowDefinition | undefined {
    console.log('[WorkflowRegistry] Resolving workflow:', {
      filePath,
      workflowId,
      availableRefs: Array.from(this.workflowsByRef.keys())
    });
    const direct = this.workflowsByRef.get(this.key(filePath, workflowId));
    if (direct) {
      console.log('[WorkflowRegistry] Found workflow by direct ref');
      return direct;
    }

    if (!path.isAbsolute(filePath)) {
      for (const workspaceFolder of getAllWorkspaceFolders()) {
        const absoluteFilePath = path.resolve(workspaceFolder, filePath);
        const workflow = this.workflowsByRef.get(this.key(absoluteFilePath, workflowId));
        if (workflow) {
          console.log(`[WorkflowRegistry] Found workflow by workspace-relative ref: ${absoluteFilePath}`);
          return workflow;
        }
      }
    }

    console.log('[WorkflowRegistry] Workflow not found');
    return undefined;
  }

  getAll(): WorkflowDefinition[] {
    return Array.from(this.workflowsByRef.values());
  }

  getErrors(): WorkflowRegistryError[] {
    return this.errors.map(error => ({
      filePath: error.filePath,
      errors: [...error.errors]
    }));
  }

  private loadWorkflowFile(filePath: string): void {
    const parsed = readJsonFile<Omit<WorkflowDefinition, 'filePath'> & { filePath?: string }>(filePath);
    if (!parsed) {
      this.errors.push({
        filePath,
        errors: ['Failed to parse workflow JSON']
      });
      return;
    }

    const workflow: WorkflowDefinition = {
      ...parsed,
      filePath
    };

    const validation = validateWorkflowDefinition(workflow, this.schemaRegistry);
    const existingFile = this.workflowIds.get(workflow.id);
    if (existingFile && existingFile !== filePath) {
      validation.errors.push(`Duplicate workflow id "${workflow.id}" already declared in ${existingFile}`);
    }

    if (!validation.valid || validation.errors.length > 0) {
      console.log(`[WorkflowRegistry] Workflow validation failed for ${filePath}: ${validation.errors.join('; ')}`);
      this.errors.push({
        filePath,
        errors: validation.errors
      });
      return;
    }

    this.workflowIds.set(workflow.id, filePath);
    this.workflowsByRef.set(this.key(filePath, workflow.id), workflow);
    console.log(`[WorkflowRegistry] Registered workflow ${workflow.id} from ${filePath}`);
  }

  private getWorkflowDirectories(): string[] {
    const dirs: string[] = [];
    for (const workspacePath of getAllWorkspaceFolders()) {
      const workflowsDir = path.join(workspacePath, WORKFLOWS_DIR);
      if (directoryExists(workflowsDir)) {
        dirs.push(workflowsDir);
      }
    }
    return dirs;
  }

  private watch(): void {
    const workspaceFolders = getAllWorkspaceFolders();
    for (const workspaceFolder of workspaceFolders) {
      const pattern = new vscode.RelativePattern(workspaceFolder, `${WORKFLOWS_DIR}/**/*.json`);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => this.reload());
      watcher.onDidChange(() => this.reload());
      watcher.onDidDelete(() => this.reload());
      this.watchers.push(watcher);
    }
  }

  private key(filePath: string, workflowId: string): string {
    return `${filePath}::${workflowId}`;
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.onDidChangeEmitter.dispose();
  }
}
