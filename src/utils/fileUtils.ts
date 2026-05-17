/**
 * File utilities for safe I/O operations and path resolution
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const WORKSPACE_FALLBACK_ENV = 'AGENT_SCHEDULES_WORKSPACE';

function getWorkspaceFallback(): string | undefined {
  const fallback = process.env[WORKSPACE_FALLBACK_ENV];
  if (!fallback || fallback.trim().length === 0) {
    return undefined;
  }
  return fallback;
}

/**
 * Get the workspace folder path, or throw if none exists
 */
export function getWorkspaceFolder(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    const fallback = getWorkspaceFallback();
    if (fallback) {
      console.log(`[fileUtils] No workspace folder open; using ${WORKSPACE_FALLBACK_ENV}=${fallback}`);
      return fallback;
    }
    throw new Error('No workspace folder open');
  }
  return workspaceFolders[0].uri.fsPath;
}

/**
 * Get all workspace folder paths
 */
export function getAllWorkspaceFolders(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    const fallback = getWorkspaceFallback();
    if (fallback) {
      console.log(`[fileUtils] No workspace folders open; using ${WORKSPACE_FALLBACK_ENV}=${fallback}`);
      return [fallback];
    }
    return [];
  }
  return workspaceFolders.map(folder => folder.uri.fsPath);
}

/**
 * Get user home directory
 */
export function getUserHome(): string {
  return os.homedir();
}

/**
 * Cursor context directory names (per official docs + convention)
 * - .cursor/commands — project & ~/.cursor/commands global
 * - .cursor/skills — project & ~/.cursor/skills-cursor global (subdirs with SKILL.md)
 * - .cursor/agents — project & ~/.cursor/agents (agents and subagents; create-subagent skill writes here)
 * - .cursor/workflows — project workflows for scheduler orchestration
 */
export const CURSOR_CONTEXT_DIRS = {
  COMMANDS: '.cursor/commands',
  SKILLS: '.cursor/skills',
  AGENTS: '.cursor/agents',
  WORKFLOWS: '.cursor/workflows'
} as const;

/** Global skills path used by Cursor (skills-cursor) */
export const GLOBAL_SKILLS_DIR = '.cursor/skills-cursor';

/**
 * Get additional command directories from configuration
 */
export function getAdditionalCommandDirs(): string[] {
  const config = vscode.workspace.getConfiguration('cursorAgentFlow');
  const additionalDirs = config.get<string[]>('additionalCommandDirectories', []);
  return additionalDirs.filter(dir => dir && dir.trim().length > 0);
}

/**
 * Get additional skill directories from configuration
 */
export function getAdditionalSkillsDirs(): string[] {
  const config = vscode.workspace.getConfiguration('cursorAgentFlow');
  const additionalDirs = config.get<string[]>('additionalSkillsDirectories', []);
  return additionalDirs.filter(dir => dir && dir.trim().length > 0);
}

/**
 * Get additional agent directories from configuration
 */
export function getAdditionalAgentsDirs(): string[] {
  const config = vscode.workspace.getConfiguration('cursorAgentFlow');
  const additionalDirs = config.get<string[]>('additionalAgentsDirectories', []);
  return additionalDirs.filter(dir => dir && dir.trim().length > 0);
}

/**
 * Get additional MCP descriptor directories from configuration.
 */
export function getAdditionalMcpDirectories(): string[] {
  const config = vscode.workspace.getConfiguration('cursorAgentFlow');
  const additionalDirs = config.get<string[]>('additionalMcpDirectories', []);
  return additionalDirs.filter(dir => dir && dir.trim().length > 0);
}

/**
 * Best-effort location of Cursor's per-workspace MCP descriptor cache.
 */
export function getDefaultMcpDescriptorDirectory(): string | undefined {
  const workspacePath = getWorkspaceFolder();
  const projectSlug = workspacePath.replace(/^[/\\]+/, '').replace(/[^A-Za-z0-9_-]+/g, '-');
  if (!projectSlug) {
    return undefined;
  }
  return path.join(getUserHome(), '.cursor', 'projects', projectSlug, 'mcps');
}

/**
 * Resolve a config path (tilde, absolute, or relative)
 */
export function resolveConfigPath(dir: string): string {
  const home = getUserHome();
  if (dir.startsWith('~')) {
    return path.join(home, dir.slice(1));
  }
  if (path.isAbsolute(dir)) {
    return dir;
  }
  return path.resolve(dir);
}

/**
 * Resolve a path relative to the workspace folder
 */
export function resolveWorkspacePath(relativePath: string): string {
  const workspacePath = getWorkspaceFolder();
  return path.resolve(workspacePath, relativePath);
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a directory exists
 */
export function directoryExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a file safely, returning undefined on error
 */
export function readFileSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Write a file safely, creating directories if needed
 */
export function writeFileSafe(filePath: string, content: string): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to write file ${filePath}:`, error);
    return false;
  }
}

/**
 * Write a file atomically by writing a same-directory temporary file first,
 * then renaming it into place.
 */
export function writeFileAtomic(filePath: string, content: string): boolean {
  const tmpPath = `${filePath}.tmp`;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best effort cleanup only.
    }
    console.error(`Failed to atomically write file ${filePath}:`, error);
    return false;
  }
}

/**
 * Read a JSON file safely
 */
export function readJsonFile<T>(filePath: string): T | undefined {
  const content = readFileSafe(filePath);
  if (!content) {
    return undefined;
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Failed to parse JSON file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Write a JSON file safely with formatting
 */
export function writeJsonFile(filePath: string, data: unknown): boolean {
  try {
    const content = JSON.stringify(data, null, 2);
    return writeFileSafe(filePath, content);
  } catch (error) {
    console.error(`Failed to write JSON file ${filePath}:`, error);
    return false;
  }
}

/**
 * Write a JSON file atomically with formatting.
 */
export function writeJsonFileAtomic(filePath: string, data: unknown): boolean {
  try {
    const content = JSON.stringify(data, null, 2);
    return writeFileAtomic(filePath, content);
  } catch (error) {
    console.error(`Failed to atomically write JSON file ${filePath}:`, error);
    return false;
  }
}

/**
 * List files in a directory
 */
export function listFiles(dirPath: string, extension?: string): string[] {
  try {
    if (!directoryExists(dirPath)) {
      return [];
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    if (extension) {
      return files.filter(f => f.endsWith(extension)).map(f => path.join(dirPath, f));
    }
    return files.map(f => path.join(dirPath, f));
  } catch (error) {
    console.error(`Failed to list files in ${dirPath}:`, error);
    return [];
  }
}

/**
 * List subdirectories of a directory (names only)
 */
export function listSubdirectories(dirPath: string): string[] {
  try {
    if (!directoryExists(dirPath)) {
      return [];
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (error) {
    console.error(`Failed to list subdirectories in ${dirPath}:`, error);
    return [];
  }
}
