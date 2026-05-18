import type { WorkflowStep, WorkflowStepRun } from '../types';
import { WORKFLOW_PREFERENCES_SCHEMA_ID } from './planSchemas';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import { WorkflowPreferenceOverride, WorkflowPreferenceProvider } from './workflowPreferenceProvider';

interface WorkflowPreferencesStepInput {
  overrides?: WorkflowPreferenceOverride[];
}

export class WorkflowPreferencesStepExecutor implements WorkflowStepExecutor {
  readonly type = 'workflowPreferences' as const;

  constructor(private readonly workflowPreferenceProvider: WorkflowPreferenceProvider) {}

  async execute(
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    context: WorkflowExecutionContext
  ): Promise<StepExecutionResult> {
    if (!step.output) {
      return {
        status: 'failed',
        error: `workflowPreferences step ${step.id} requires an output artifact`
      };
    }
    if (step.output.schema !== WORKFLOW_PREFERENCES_SCHEMA_ID) {
      return {
        status: 'failed',
        error: `workflowPreferences step ${step.id} output.schema must be ${WORKFLOW_PREFERENCES_SCHEMA_ID}`
      };
    }

    const input = step.input as WorkflowPreferencesStepInput | undefined;
    const overrideValidationError = this.validateOverrides(input?.overrides);
    if (overrideValidationError) {
      return {
        status: 'failed',
        error: overrideValidationError
      };
    }

    const snapshot = this.workflowPreferenceProvider.snapshot(input?.overrides ?? []);
    stepRun.expectedArtifact = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
    const outputArtifact = context.artifactStore.writeJson(step.output.path, snapshot, context.variables);

    const traceStore = new TraceStore(context.run.runDir);
    traceStore.appendTyped(TRACE_EVENTS.WORKFLOW_PREFERENCES_DISCOVERED, {
      artifacts: [{ path: step.output.path }],
      preferenceIds: snapshot.preferences.map(preference => preference.id),
      skipped: snapshot.skipped ?? []
    });
    traceStore.appendTyped(TRACE_EVENTS.WORKFLOW_PREFERENCES_RESOLVED, {
      artifacts: [{ path: step.output.path }],
      preferenceIds: snapshot.resolvedPreferenceIds
    });
    if (snapshot.overriddenPreferenceIds.length > 0) {
      traceStore.appendTyped(TRACE_EVENTS.WORKFLOW_PREFERENCES_CONFLICT, {
        kind: 'override',
        artifacts: [{ path: step.output.path }],
        preferenceIds: snapshot.overriddenPreferenceIds
      });
    }

    return {
      status: 'succeeded',
      outputArtifact,
      output: snapshot
    };
  }

  private validateOverrides(overrides: WorkflowPreferenceOverride[] | undefined): string | undefined {
    if (overrides === undefined) {
      return undefined;
    }
    if (!Array.isArray(overrides)) {
      return 'workflowPreferences input.overrides must be an array';
    }
    for (const [index, override] of overrides.entries()) {
      if (!override || typeof override !== 'object') {
        return `workflowPreferences input.overrides[${index}] must be an object`;
      }
      if (typeof override.id !== 'string' || override.id.trim().length === 0) {
        return `workflowPreferences input.overrides[${index}].id must be a non-empty string`;
      }
      if (typeof override.content !== 'string' || override.content.trim().length === 0) {
        return `workflowPreferences input.overrides[${index}].content must be a non-empty string`;
      }
    }
    return undefined;
  }
}
