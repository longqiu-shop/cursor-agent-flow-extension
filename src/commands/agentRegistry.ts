/**
 * Registry for Cursor-style agents from .cursor/agents
 * (and ~/.cursor/agents). Same file format as commands: .md, .json, .yaml.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Command } from '../types';
import {
  listFiles,
  directoryExists,
  getAllWorkspaceFolders,
  getUserHome,
  getAdditionalAgentsDirs,
  CURSOR_CONTEXT_DIRS,
  resolveConfigPath
} from '../utils/fileUtils';
import { parseCommandFile } from '../utils/commandParser';

const AGENTS_DIR = CURSOR_CONTEXT_DIRS.AGENTS;

export class AgentRegistry implements vscode.Disposable {
  private agents: Map<string, Command> = new Map();
  private watchers: vscode.FileSystemWatcher[] = [];
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    this.reload();
    this.watch();
  }

  private getDirectories(): string[] {
    const dirs: string[] = [];

    for (const workspacePath of getAllWorkspaceFolders()) {
      const d = path.join(workspacePath, AGENTS_DIR);
      if (directoryExists(d)) dirs.push(d);
    }

    const homeAgents = path.join(getUserHome(), AGENTS_DIR);
    if (directoryExists(homeAgents)) dirs.push(homeAgents);

    for (const dir of getAdditionalAgentsDirs()) {
      const resolved = resolveConfigPath(dir);
      if (directoryExists(resolved)) dirs.push(resolved);
    }

    return dirs;
  }

  reload(): void {
    this.agents.clear();
    const agentDirs = this.getDirectories();

    for (const agentsDir of agentDirs) {
      const jsonFiles = listFiles(agentsDir, '.json');
      const yamlFiles = listFiles(agentsDir, '.yaml').concat(listFiles(agentsDir, '.yml'));
      const mdFiles = listFiles(agentsDir, '.md').concat(listFiles(agentsDir, '.markdown'));
      const allFiles = [...jsonFiles, ...yamlFiles, ...mdFiles];

      for (const filePath of allFiles) {
        const agent = parseCommandFile(filePath);
        if (agent) this.agents.set(this.key(agent.filePath, agent.id), agent);
      }
    }

    this.onDidChangeEmitter.fire();
  }

  private key(filePath: string, id: string): string {
    return `${filePath}::${id}`;
  }

  get(filePath: string, agentId: string): Command | undefined {
    return this.agents.get(this.key(filePath, agentId));
  }

  getAll(): Command[] {
    return Array.from(this.agents.values());
  }

  private watch(): void {
    const dirs = this.getDirectories();
    const workspaceFolders = getAllWorkspaceFolders();

    for (const dir of dirs) {
      const workspaceFolder = workspaceFolders.find(wf => dir.startsWith(wf));
      const watcher = workspaceFolder
        ? vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, path.relative(workspaceFolder, dir) + '/**/*.{json,yaml,yml,md,markdown}')
          )
        : vscode.workspace.createFileSystemWatcher(dir.replace(/\\/g, '/') + '/**/*.{json,yaml,yml,md,markdown}');

      watcher.onDidCreate(() => this.reload());
      watcher.onDidChange(() => this.reload());
      watcher.onDidDelete(() => this.reload());
      this.watchers.push(watcher);
    }
  }

  dispose(): void {
    this.watchers.forEach(w => w.dispose());
    this.watchers = [];
    this.onDidChangeEmitter.dispose();
  }
}
