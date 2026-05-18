import * as path from 'path';
import type { WorkflowStep, WorkflowStepRun } from '../types';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import {
  ToolContextProvider,
  ToolInventoryOptions
} from './toolContextProvider';
import type { ToolInventorySource, WorkflowPreferencesArtifact } from './planSchemas';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';
import { renderTemplate } from './variableResolver';

interface ToolInventoryStepInput {
  include?: string[];
  workflowPreferencesArtifact?: string;
}

const TOOL_INVENTORY_SOURCES = new Set<ToolInventorySource>([
  'commands',
  'skills',
  'agents',
  'workflowPrimitives',
  'runtimeActions',
  'mcpTools',
  'workflowPreferences'
]);

export class ToolInventoryStepExecutor implements WorkflowStepExecutor {
  readonly type = 'toolInventory' as const;

  constructor(private readonly toolContextProvider: ToolContextProvider) {}

  async execute(
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    context: WorkflowExecutionContext
  ): Promise<StepExecutionResult> {
    if (!step.output) {
      return {
        status: 'failed',
        error: `toolInventory step ${step.id} requires an output artifact`
      };
    }

    const input = step.input as ToolInventoryStepInput | undefined;
    const options = this.getOptions(input, context);
    if (!options.ok) {
      return {
        status: 'failed',
        error: options.error
      };
    }

    const inventory = this.toolContextProvider.snapshot(options.value);
    stepRun.expectedArtifact = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
    const outputArtifact = context.artifactStore.writeJson(step.output.path, inventory, context.variables);
    new TraceStore(context.run.runDir).appendTyped(TRACE_EVENTS.TOOL_INVENTORY_CREATED, {
      artifacts: [{ path: step.output.path }]
    });

    return {
      status: 'succeeded',
      outputArtifact,
      output: inventory
    };
  }

  private getOptions(
    input: ToolInventoryStepInput | undefined,
    context: WorkflowExecutionContext
  ): { ok: true; value: ToolInventoryOptions } | { ok: false; error: string } {
    const include: ToolInventorySource[] = [];
    if (input?.include) {
      for (const source of input.include) {
        if (!TOOL_INVENTORY_SOURCES.has(source as ToolInventorySource)) {
          return {
            ok: false,
            error: `toolInventory input.include contains unsupported source: ${source}`
          };
        }
        include.push(source as ToolInventorySource);
      }
    }

    const options: ToolInventoryOptions = include.length > 0 ? { include } : {};
    if (input?.workflowPreferencesArtifact) {
      let artifactPath: string;
      try {
        artifactPath = this.resolveRunRelativeArtifact(input.workflowPreferencesArtifact, context);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      const preferences = context.artifactStore.readJson<WorkflowPreferencesArtifact>(artifactPath, context.variables);
      if (!preferences || !Array.isArray(preferences.preferences)) {
        return {
          ok: false,
          error: `toolInventory input.workflowPreferencesArtifact could not be read: ${artifactPath}`
        };
      }
      options.workflowPreferences = preferences.preferences;
    }

    return { ok: true, value: options };
  }

  private resolveRunRelativeArtifact(artifactPathTemplate: string, context: WorkflowExecutionContext): string {
    const renderedPath = renderTemplate(artifactPathTemplate, context.variables);
    if (!path.isAbsolute(renderedPath)) {
      return renderedPath;
    }

    const relativePath = path.relative(context.run.runDir, renderedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`toolInventory artifact path must be inside runDir: ${renderedPath}`);
    }
    if (relativePath.length === 0) {
      throw new Error(`toolInventory artifact path must point to a file inside runDir: ${renderedPath}`);
    }

    return relativePath;
  }
}
