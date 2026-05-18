import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command } from '../types';
import type { AgentRegistry } from '../commands/agentRegistry';
import type { CommandRegistry } from '../commands/commandRegistry';
import type { SkillRegistry } from '../commands/skillRegistry';
import {
  PLAN_SCHEMA_VERSION,
  ToolInventory,
  ToolInventoryEntry,
  ToolInventorySource,
  WorkflowPreferenceEntry
} from './planSchemas';
import { WorkflowPreferenceProvider } from './workflowPreferenceProvider';

export interface ToolContextProviderSources {
  commands?: Command[];
  skills?: Command[];
  agents?: Command[];
  mcpTools?: McpToolDescriptor[];
  mcpDescriptorDirectories?: string[];
  workflowPreferences?: WorkflowPreferenceEntry[];
  workflowPreferenceProvider?: WorkflowPreferenceProvider;
}

export interface ToolContextProviderRegistries {
  commandRegistry: CommandRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  mcpDescriptorDirectories?: string[];
  workflowPreferenceProvider?: WorkflowPreferenceProvider;
}

export interface ToolInventoryOptions {
  include?: ToolInventorySource[];
  workflowPreferences?: WorkflowPreferenceEntry[];
}

type ToolContextProviderSourceFactory = () => ToolContextProviderSources;

export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string;
}

const DEFAULT_SOURCES: ToolInventorySource[] = [
  'commands',
  'skills',
  'agents',
  'workflowPrimitives',
  'runtimeActions',
  'mcpTools',
  'workflowPreferences'
];

export class ToolContextProvider {
  constructor(private readonly sources: ToolContextProviderSources | ToolContextProviderSourceFactory) {}

  static fromRegistries(registries: ToolContextProviderRegistries): ToolContextProvider {
    return new ToolContextProvider(() => ({
      commands: registries.commandRegistry.getAllCommands(),
      skills: registries.skillRegistry.getAll(),
      agents: registries.agentRegistry.getAll(),
      mcpDescriptorDirectories: registries.mcpDescriptorDirectories ?? [],
      workflowPreferenceProvider: registries.workflowPreferenceProvider
    }));
  }

  snapshot(options: ToolInventoryOptions = {}): ToolInventory {
    const include = new Set(options.include ?? DEFAULT_SOURCES);
    const sources = typeof this.sources === 'function' ? this.sources() : this.sources;
    const tools: ToolInventoryEntry[] = [];

    if (include.has('commands')) {
      tools.push(...this.commandTools('commands', sources.commands ?? []));
    }
    if (include.has('skills')) {
      tools.push(...this.commandTools('skills', sources.skills ?? []));
    }
    if (include.has('agents')) {
      tools.push(...this.commandTools('agents', sources.agents ?? []));
    }
    if (include.has('workflowPrimitives')) {
      tools.push(...this.workflowPrimitiveTools());
    }
    if (include.has('runtimeActions')) {
      tools.push(...this.runtimeActionTools());
    }
    if (include.has('mcpTools')) {
      tools.push(...this.mcpTools(sources));
    }
    if (include.has('workflowPreferences')) {
      tools.push(...this.workflowPreferenceTools(
        options.workflowPreferences
        ?? sources.workflowPreferences
        ?? sources.workflowPreferenceProvider?.snapshot().preferences
        ?? []
      ));
    }

    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      tools: this.dedupeAndSort(tools)
    };
  }

  private commandTools(source: Extract<ToolInventorySource, 'commands' | 'skills' | 'agents'>, commands: Command[]): ToolInventoryEntry[] {
    return commands.map(command => ({
      id: `${source}.${this.safeToolId(command.id)}`,
      source,
      capabilities: ['read'],
      description: command.description
    }));
  }

  private workflowPrimitiveTools(): ToolInventoryEntry[] {
    return [
      {
        id: 'workflow.agent',
        source: 'workflowPrimitives',
        capabilities: ['read', 'workspaceWrite'],
        description: 'Run a Cursor agent task that writes declared artifacts'
      },
      {
        id: 'workflow.readJson',
        source: 'workflowPrimitives',
        capabilities: ['read'],
        description: 'Read and validate a JSON artifact from the run directory'
      },
      {
        id: 'workflow.fanout',
        source: 'workflowPrimitives',
        capabilities: ['read'],
        description: 'Run child workflow steps sequentially for each item'
      },
      {
        id: 'workflow.join',
        source: 'workflowPrimitives',
        capabilities: ['read'],
        description: 'Join multiple text artifacts into a summary artifact'
      },
      {
        id: 'workflow.toolInventory',
        source: 'workflowPrimitives',
        capabilities: ['read'],
        description: 'Snapshot available commands, skills, agents, and workflow primitives'
      }
    ];
  }

  private runtimeActionTools(): ToolInventoryEntry[] {
    return [
      {
        id: 'runtime.block',
        source: 'runtimeActions',
        capabilities: ['read'],
        description: 'Stop the plan run with a clear block reason'
      },
      {
        id: 'runtime.needsApproval',
        source: 'runtimeActions',
        capabilities: ['read'],
        description: 'Stop the plan run and request human approval'
      }
    ];
  }

  private mcpTools(sources: ToolContextProviderSources): ToolInventoryEntry[] {
    const descriptors = [
      ...(sources.mcpTools ?? []),
      ...this.discoverMcpTools(sources.mcpDescriptorDirectories ?? [])
    ];

    return descriptors.map(descriptor => ({
      id: `mcp.${this.safeToolId(descriptor.server)}.${this.safeToolId(descriptor.name)}`,
      source: 'mcpTools',
      capabilities: ['read'],
      description: descriptor.description
        ? `${descriptor.server}/${descriptor.name}: ${descriptor.description}`
        : `${descriptor.server}/${descriptor.name}`
    }));
  }

  private workflowPreferenceTools(preferences: WorkflowPreferenceEntry[]): ToolInventoryEntry[] {
    return preferences.map(preference => ({
      id: `workflowPreferences.${this.safeToolId(preference.id)}`,
      source: 'workflowPreferences',
      capabilities: ['planning'],
      description: `${preference.title}: ${preference.summary}`,
      ...(preference.path ? { path: preference.path } : {}),
      title: preference.title,
      summary: preference.summary
    }));
  }

  private discoverMcpTools(directories: string[]): McpToolDescriptor[] {
    const tools: McpToolDescriptor[] = [];
    for (const directory of directories) {
      const baseDir = this.resolveConfigPath(directory);
      if (!this.isDirectory(baseDir)) {
        continue;
      }

      for (const server of this.safeReadDirNames(baseDir, entry => entry.isDirectory())) {
        const toolsDir = path.join(baseDir, server, 'tools');
        if (!this.isDirectory(toolsDir)) {
          continue;
        }

        for (const fileName of this.safeReadDirNames(toolsDir, entry => entry.isFile() && entry.name.endsWith('.json'))) {
          const descriptor = this.readMcpToolDescriptor(path.join(toolsDir, fileName));
          if (descriptor) {
            tools.push({
              server,
              name: descriptor.name ?? path.basename(fileName, '.json'),
              description: descriptor.description
            });
          }
        }
      }
    }
    return tools;
  }

  private resolveConfigPath(dir: string): string {
    if (dir.startsWith('~')) {
      return path.join(os.homedir(), dir.slice(1));
    }
    if (path.isAbsolute(dir)) {
      return dir;
    }
    return path.resolve(dir);
  }

  private readMcpToolDescriptor(filePath: string): { name?: string; description?: string } | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { name?: unknown; description?: unknown };
      return {
        name: typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name : undefined,
        description: typeof parsed.description === 'string' && parsed.description.trim().length > 0 ? parsed.description : undefined
      };
    } catch {
      return undefined;
    }
  }

  private safeReadDirNames(dirPath: string, predicate: (entry: fs.Dirent) => boolean): string[] {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true }).filter(predicate).map(entry => entry.name);
    } catch {
      return [];
    }
  }

  private isDirectory(dirPath: string): boolean {
    try {
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }

  private dedupeAndSort(tools: ToolInventoryEntry[]): ToolInventoryEntry[] {
    const counts = new Map<string, number>();
    const result = tools.map(tool => {
      const count = counts.get(tool.id) ?? 0;
      counts.set(tool.id, count + 1);
      if (count === 0) {
        return tool;
      }
      return {
        ...tool,
        id: `${tool.id}.${this.shortHash(`${tool.source}:${tool.description ?? ''}:${count}`)}`
      };
    });

    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  private safeToolId(value: string): string {
    const normalized = value.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || this.shortHash(value);
  }

  private shortHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  }
}
