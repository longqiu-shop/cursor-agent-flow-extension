import type { WorkflowStep, WorkflowStepRun } from '../types';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import {
  ToolContextProvider,
  ToolInventoryOptions
} from './toolContextProvider';
import type { ToolInventorySource } from './planSchemas';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';

interface ToolInventoryStepInput {
  include?: string[];
}

const TOOL_INVENTORY_SOURCES = new Set<ToolInventorySource>([
  'commands',
  'skills',
  'agents',
  'workflowPrimitives',
  'runtimeActions',
  'mcpTools'
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

    const options = this.getOptions(step.input as ToolInventoryStepInput | undefined);
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

  private getOptions(input: ToolInventoryStepInput | undefined): { ok: true; value: ToolInventoryOptions } | { ok: false; error: string } {
    if (!input?.include) {
      return { ok: true, value: {} };
    }

    const include: ToolInventorySource[] = [];
    for (const source of input.include) {
      if (!TOOL_INVENTORY_SOURCES.has(source as ToolInventorySource)) {
        return {
          ok: false,
          error: `toolInventory input.include contains unsupported source: ${source}`
        };
      }
      include.push(source as ToolInventorySource);
    }

    return { ok: true, value: { include } };
  }
}
