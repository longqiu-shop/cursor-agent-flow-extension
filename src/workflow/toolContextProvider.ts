import * as crypto from 'crypto';
import type { Command } from '../types';
import type { AgentRegistry } from '../commands/agentRegistry';
import type { CommandRegistry } from '../commands/commandRegistry';
import type { SkillRegistry } from '../commands/skillRegistry';
import {
  PLAN_SCHEMA_VERSION,
  ToolInventory,
  ToolInventoryEntry,
  ToolInventorySource
} from './planSchemas';

export interface ToolContextProviderSources {
  commands?: Command[];
  skills?: Command[];
  agents?: Command[];
}

export interface ToolContextProviderRegistries {
  commandRegistry: CommandRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
}

export interface ToolInventoryOptions {
  include?: ToolInventorySource[];
}

type ToolContextProviderSourceFactory = () => ToolContextProviderSources;

const DEFAULT_SOURCES: ToolInventorySource[] = [
  'commands',
  'skills',
  'agents',
  'workflowPrimitives',
  'runtimeActions'
];

export class ToolContextProvider {
  constructor(private readonly sources: ToolContextProviderSources | ToolContextProviderSourceFactory) {}

  static fromRegistries(registries: ToolContextProviderRegistries): ToolContextProvider {
    return new ToolContextProvider(() => ({
      commands: registries.commandRegistry.getAllCommands(),
      skills: registries.skillRegistry.getAll(),
      agents: registries.agentRegistry.getAll()
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
