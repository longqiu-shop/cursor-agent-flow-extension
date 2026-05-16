/**
 * Registry for Cursor skills from .cursor/skills (subdirs with SKILL.md)
 * and ~/.cursor/skills-cursor. See Cursor docs: context/skills
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Command } from '../types';
import {
  listSubdirectories,
  listFiles,
  directoryExists,
  getAllWorkspaceFolders,
  getUserHome,
  getAdditionalSkillsDirs,
  CURSOR_CONTEXT_DIRS,
  GLOBAL_SKILLS_DIR,
  resolveConfigPath,
  readFileSafe
} from '../utils/fileUtils';
import { parseSkillFile } from '../utils/commandParser';

const SKILLS_DIR = CURSOR_CONTEXT_DIRS.SKILLS;

export class SkillRegistry implements vscode.Disposable {
  private skills: Map<string, Command> = new Map();
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
      const d = path.join(workspacePath, SKILLS_DIR);
      if (directoryExists(d)) dirs.push(d);
    }

    const globalSkills = path.join(getUserHome(), GLOBAL_SKILLS_DIR);
    if (directoryExists(globalSkills)) dirs.push(globalSkills);

    for (const dir of getAdditionalSkillsDirs()) {
      const resolved = resolveConfigPath(dir);
      if (directoryExists(resolved)) dirs.push(resolved);
    }

    return dirs;
  }

  reload(): void {
    this.skills.clear();
    const skillDirs = this.getDirectories();

    for (const skillsDir of skillDirs) {
      const subdirs = listSubdirectories(skillsDir);
      for (const subdir of subdirs) {
        const skillPath = path.join(skillsDir, subdir, 'SKILL.md');
        const content = readFileSafe(skillPath);
        if (content) {
          const skill = parseSkillFile(skillPath, content);
          if (skill) {
            this.skills.set(this.key(skill.filePath, skill.id), skill);
          }
        }
      }
      // Also allow top-level .md in skills dir (single-file skills)
      const mdFiles = listFiles(skillsDir, '.md').filter(p => !p.endsWith('SKILL.md'));
      for (const filePath of mdFiles) {
        const content = readFileSafe(filePath);
        if (content) {
          const skill = parseSkillFile(filePath, content);
          if (skill) this.skills.set(this.key(skill.filePath, skill.id), skill);
        }
      }
    }

    this.onDidChangeEmitter.fire();
  }

  private key(filePath: string, id: string): string {
    return `${filePath}::${id}`;
  }

  get(filePath: string, skillId: string): Command | undefined {
    return this.skills.get(this.key(filePath, skillId));
  }

  getAll(): Command[] {
    return Array.from(this.skills.values());
  }

  private watch(): void {
    const dirs = this.getDirectories();
    const workspaceFolders = getAllWorkspaceFolders();

    for (const dir of dirs) {
      const workspaceFolder = workspaceFolders.find(wf => dir.startsWith(wf));
      const watcher = workspaceFolder
        ? vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, path.relative(workspaceFolder, dir) + '/**/*.md')
          )
        : vscode.workspace.createFileSystemWatcher(dir.replace(/\\/g, '/') + '/**/*.md');

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
