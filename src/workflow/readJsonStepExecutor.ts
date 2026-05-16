import { WorkflowStep } from '../types';
import { getVariable } from './variableResolver';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';

interface ReadJsonInput {
  path?: string;
  schema?: string;
  select?: string;
}

export class ReadJsonStepExecutor implements WorkflowStepExecutor {
  readonly type = 'readJson' as const;

  async execute(step: WorkflowStep, _stepRun: import('../types').WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const input = step.input as ReadJsonInput | undefined;
    if (!input?.path) {
      return {
        status: 'failed',
        error: `readJson step ${step.id} requires input.path`
      };
    }

    const artifactPath = context.artifactStore.resolveArtifactPath(input.path, context.variables);
    const value = context.artifactStore.readJson<unknown>(input.path, context.variables);
    if (value === undefined) {
      return {
        status: 'failed',
        error: `readJson step ${step.id} could not read JSON artifact: ${artifactPath}`
      };
    }

    const validation = context.artifactStore.validateJsonValue(input.schema, value);
    if (!validation.valid) {
      return {
        status: 'failed',
        error: validation.errors.join('; '),
        outputArtifact: artifactPath
      };
    }

    const output = input.select
      ? getVariable(input.select, validation.value as Record<string, unknown>)
      : validation.value;

    if (output === undefined) {
      return {
        status: 'failed',
        error: `readJson step ${step.id} select path not found: ${input.select}`,
        outputArtifact: artifactPath
      };
    }

    return {
      status: 'succeeded',
      outputArtifact: artifactPath,
      output
    };
  }
}
