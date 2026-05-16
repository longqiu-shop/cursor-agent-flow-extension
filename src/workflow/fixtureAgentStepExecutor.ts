import { StepStatus, WorkflowStep } from '../types';
import { WorkflowExecutionContext, WorkflowStepExecutor, StepExecutionResult } from './workflowRunner';

interface FixtureAgentInput {
  title?: string;
  prompt?: string;
  fixtureStatus?: StepStatus;
  fixtureText?: string;
  fixtureJson?: unknown;
  fixtureError?: string;
  fixtureBlockedReason?: string;
  fixtureDelayMs?: number;
}

export class FixtureAgentStepExecutor implements WorkflowStepExecutor {
  readonly type = 'agent' as const;

  async execute(
    step: WorkflowStep,
    stepRun: import('../types').WorkflowStepRun,
    context: WorkflowExecutionContext
  ): Promise<StepExecutionResult> {
    const input = step.input as FixtureAgentInput | undefined;
    const delayMs = input?.fixtureDelayMs ?? 0;
    if (delayMs > 0) {
      await this.delay(delayMs, context.token);
    }

    if (context.token.isCancellationRequested) {
      return { status: 'cancelled' };
    }

    const status = input?.fixtureStatus ?? 'succeeded';
    if (status !== 'succeeded') {
      return {
        status,
        error: input?.fixtureError,
        blockedReason: input?.fixtureBlockedReason
      };
    }

    let outputArtifact: string | undefined;
    if (step.output) {
      stepRun.expectedArtifact = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
      if (step.output.format === 'json') {
        outputArtifact = context.artifactStore.writeJson(step.output.path, input?.fixtureJson ?? {}, context.variables);
      } else {
        outputArtifact = context.artifactStore.writeText(step.output.path, input?.fixtureText ?? '', context.variables);
      }
    }

    return {
      status: 'succeeded',
      outputArtifact
    };
  }

  private delay(ms: number, token: import('vscode').CancellationToken): Promise<void> {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, ms);
      const disposable = token.onCancellationRequested(() => {
        clearTimeout(timeout);
        disposable.dispose();
        resolve();
      });
    });
  }
}
