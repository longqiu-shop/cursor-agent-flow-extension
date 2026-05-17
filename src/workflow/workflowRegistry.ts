import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowDefinition } from '../types';
import { CURSOR_CONTEXT_DIRS, directoryExists, getAllWorkspaceFolders, listFiles, readJsonFile } from '../utils/fileUtils';
import { validateWorkflowDefinition } from './workflowValidation';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';
import {
  createPlannerContractMetadata,
  getExtensionDefaultWorkflowDirectories,
  PlannerContractSource
} from './plannerContractResolver';

const WORKFLOWS_DIR = CURSOR_CONTEXT_DIRS.WORKFLOWS;

interface WorkflowDirectory {
  path: string;
  source: PlannerContractSource;
}

interface WorkflowRegistryError {
  filePath: string;
  errors: string[];
}

export interface WorkflowRegistryOptions {
  extensionPath?: string;
  extensionVersion?: string;
  now?: () => string;
}

export class WorkflowRegistry implements vscode.Disposable {
  private workflowsByRef: Map<string, WorkflowDefinition> = new Map();
  private workflowIds: Map<string, string> = new Map();
  private workflowSources: Map<string, PlannerContractSource> = new Map();
  private errors: WorkflowRegistryError[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly schemaRegistry: WorkflowSchemaRegistry = createWorkflowSchemaRegistry(),
    private readonly options: WorkflowRegistryOptions = {}
  ) {
    this.reload();
    this.watch();
  }

  reload(): void {
    this.workflowsByRef.clear();
    this.workflowIds.clear();
    this.workflowSources.clear();
    this.errors = [];
    this.schemaRegistry.clearJsonSchemas();

    const workflowDirectories = this.getWorkflowDirectories();
    console.log(`[WorkflowRegistry] Reloading workflows from ${workflowDirectories.length} directorie(s): ${workflowDirectories.map(dir => dir.path).join(', ')}`);
    for (const workflowsDir of workflowDirectories) {
      this.loadWorkflowSchemas(workflowsDir.path);
    }
    for (const workflowsDir of workflowDirectories) {
      for (const filePath of listFiles(workflowsDir.path, '.json')) {
        if (filePath.endsWith('.schema.json')) {
          continue;
        }
        this.loadWorkflowFile(filePath, workflowsDir.source);
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

  getById(workflowId: string): WorkflowDefinition | undefined {
    const filePath = this.workflowIds.get(workflowId);
    return filePath ? this.workflowsByRef.get(this.key(filePath, workflowId)) : undefined;
  }

  getErrors(): WorkflowRegistryError[] {
    return this.errors.map(error => ({
      filePath: error.filePath,
      errors: [...error.errors]
    }));
  }

  private loadWorkflowFile(filePath: string, source: PlannerContractSource): void {
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
      const existingSource = this.workflowSources.get(existingFile);
      if (source === 'extension-default' && existingSource === 'project-override') {
        console.log(`[WorkflowRegistry] Skipping extension default workflow ${workflow.id}; project override exists at ${existingFile}`);
        return;
      }
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

    const workflowWithPlannerContract = this.attachPlannerContract(workflow, source);

    this.workflowIds.set(workflow.id, filePath);
    this.workflowSources.set(filePath, source);
    this.workflowsByRef.set(this.key(filePath, workflow.id), workflowWithPlannerContract);
    console.log(`[WorkflowRegistry] Registered workflow ${workflow.id} from ${filePath}`);
  }

  private loadWorkflowSchemas(workflowsDir: string): void {
    for (const filePath of this.listSchemaFiles(workflowsDir)) {
      const schema = readJsonFile<unknown>(filePath);
      if (!schema) {
        this.errors.push({
          filePath,
          errors: ['Failed to parse workflow schema JSON']
        });
        continue;
      }

      const validation = this.schemaRegistry.registerJsonSchema(schema, filePath);
      if (!validation.valid) {
        this.errors.push({
          filePath,
          errors: validation.errors
        });
      }
    }
  }

  private listSchemaFiles(dirPath: string): string[] {
    if (!directoryExists(dirPath)) {
      return [];
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.listSchemaFiles(entryPath));
      } else if (entry.isFile() && entry.name.endsWith('.schema.json')) {
        files.push(entryPath);
      }
    }
    return files;
  }

  private getWorkflowDirectories(): WorkflowDirectory[] {
    const dirs: WorkflowDirectory[] = [];
    for (const workspacePath of getAllWorkspaceFolders()) {
      const workflowsDir = path.join(workspacePath, WORKFLOWS_DIR);
      if (directoryExists(workflowsDir)) {
        dirs.push({ path: workflowsDir, source: 'project-override' });
      }
    }
    if (this.options.extensionPath) {
      for (const workflowsDir of getExtensionDefaultWorkflowDirectories(this.options.extensionPath)) {
        if (directoryExists(workflowsDir)) {
          dirs.push({ path: workflowsDir, source: 'extension-default' });
        }
      }
    }
    return dirs;
  }

  private attachPlannerContract(workflow: WorkflowDefinition, source: PlannerContractSource): WorkflowDefinition {
    const plannerContract = createPlannerContractMetadata(workflow, {
      source,
      extensionVersion: this.options.extensionVersion,
      now: this.options.now
    });
    return plannerContract ? { ...workflow, plannerContract } : workflow;
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
