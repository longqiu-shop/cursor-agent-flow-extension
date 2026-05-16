/**
 * Command registry for scanning and managing commands from ./.cursor/commands
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Command } from '../types';
import { listFiles, directoryExists, getAllWorkspaceFolders, getUserHome, getAdditionalCommandDirs, CURSOR_CONTEXT_DIRS, resolveConfigPath } from '../utils/fileUtils';
import { parseCommandFile } from '../utils/commandParser';

const COMMANDS_DIR = CURSOR_CONTEXT_DIRS.COMMANDS;

export class CommandRegistry implements vscode.Disposable {
  private commands: Map<string, Command> = new Map();
  private watchers: vscode.FileSystemWatcher[] = [];
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor() {
    this.reloadCommands();
    this.watchCommands();
  }

  /**
   * Get all command directories to search
   */
  private getCommandDirectories(): string[] {
    const dirs: string[] = [];

    // 1. Workspace folders
    const workspaceFolders = getAllWorkspaceFolders();
    for (const workspacePath of workspaceFolders) {
      const workspaceCommandsDir = path.join(workspacePath, COMMANDS_DIR);
      if (directoryExists(workspaceCommandsDir)) {
        dirs.push(workspaceCommandsDir);
      }
    }

    // 2. User home directory
    const homeCommandsDir = path.join(getUserHome(), COMMANDS_DIR);
    if (directoryExists(homeCommandsDir)) {
      dirs.push(homeCommandsDir);
    }

    // 3. Additional configured directories
    for (const dir of getAdditionalCommandDirs()) {
      const resolvedDir = resolveConfigPath(dir);
      if (directoryExists(resolvedDir)) {
        dirs.push(resolvedDir);
      } else {
        console.log(`Configured command directory does not exist: ${resolvedDir}`);
      }
    }

    return dirs;
  }

  /**
   * Reload all commands from all command directories
   */
  reloadCommands(): void {
    this.commands.clear();
    const commandDirs = this.getCommandDirectories();

    if (commandDirs.length === 0) {
      console.log('No command directories found');
      return;
    }

    let totalLoaded = 0;

    for (const commandsDir of commandDirs) {
      // Find all command files
      const jsonFiles = listFiles(commandsDir, '.json');
      const yamlFiles = listFiles(commandsDir, '.yaml').concat(listFiles(commandsDir, '.yml'));
      const mdFiles = listFiles(commandsDir, '.md').concat(listFiles(commandsDir, '.markdown'));

      const allFiles = [...jsonFiles, ...yamlFiles, ...mdFiles];

      for (const filePath of allFiles) {
        const command = parseCommandFile(filePath);
        if (command) {
          const key = this.getCommandKey(command.filePath, command.id);
          this.commands.set(key, command);
          totalLoaded++;
        }
      }

      console.log(`Loaded ${allFiles.length} command files from ${commandsDir}`);
    }

    console.log(`Total: Loaded ${totalLoaded} commands from ${commandDirs.length} directory(ies)`);
    this.onDidChangeEmitter.fire();
  }

  /**
   * Get a command by file path and ID
   */
  getCommand(filePath: string, commandId: string): Command | undefined {
    const key = this.getCommandKey(filePath, commandId);
    return this.commands.get(key);
  }

  /**
   * Get all commands
   */
  getAllCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * Get commands grouped by file
   */
  getCommandsByFile(): Map<string, Command[]> {
    const byFile = new Map<string, Command[]>();
    for (const command of this.commands.values()) {
      const fileCommands = byFile.get(command.filePath) || [];
      fileCommands.push(command);
      byFile.set(command.filePath, fileCommands);
    }
    return byFile;
  }

  /**
   * Get a unique key for a command
   */
  private getCommandKey(filePath: string, commandId: string): string {
    return `${filePath}::${commandId}`;
  }

  /**
   * Set up file watchers for all command directories
   */
  private watchCommands(): void {
    const commandDirs = this.getCommandDirectories();
    const workspaceFolders = getAllWorkspaceFolders();

    for (const commandsDir of commandDirs) {
      let watcher: vscode.FileSystemWatcher;

      // Check if this directory is within a workspace folder
      const workspaceFolder = workspaceFolders.find(wf => commandsDir.startsWith(wf));
      
      if (workspaceFolder) {
        // Use RelativePattern for workspace directories
        const relativePath = path.relative(workspaceFolder, commandsDir);
        const pattern = new vscode.RelativePattern(workspaceFolder, `${relativePath}/**/*.{json,yaml,yml,md,markdown}`);
        watcher = vscode.workspace.createFileSystemWatcher(pattern);
      } else {
        // For directories outside workspace, use glob pattern with absolute path
        // Note: VS Code file watchers work best with workspace-relative paths
        // For external paths, we'll use a glob pattern
        const globPattern = `${commandsDir.replace(/\\/g, '/')}/**/*.{json,yaml,yml,md,markdown}`;
        watcher = vscode.workspace.createFileSystemWatcher(globPattern);
      }

      watcher.onDidCreate(() => {
        console.log(`Command file created in ${commandsDir}, reloading...`);
        this.reloadCommands();
      });
      watcher.onDidChange(() => {
        console.log(`Command file changed in ${commandsDir}, reloading...`);
        this.reloadCommands();
      });
      watcher.onDidDelete(() => {
        console.log(`Command file deleted in ${commandsDir}, reloading...`);
        this.reloadCommands();
      });

      this.watchers.push(watcher);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.onDidChangeEmitter.dispose();
  }
}
