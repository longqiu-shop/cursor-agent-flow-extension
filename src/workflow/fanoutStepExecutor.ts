import { WorkflowStep, WorkflowStepRun } from '../types';
import { getVariable } from './variableResolver';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';

interface FanoutInput {
  itemsFrom?: string;
  step?: WorkflowStep;
}

export class FanoutStepExecutor implements WorkflowStepExecutor {
  readonly type = 'fanout' as const;

  async execute(step: WorkflowStep, _stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const input = step.input as FanoutInput | undefined;
    if (!input?.itemsFrom) {
      return {
        status: 'failed',
        error: `fanout step ${step.id} requires input.itemsFrom`
      };
    }
    if (!input.step) {
      return {
        status: 'failed',
        error: `fanout step ${step.id} requires input.step`
      };
    }

    const items = getVariable(input.itemsFrom, context.variables);
    if (!Array.isArray(items)) {
      return {
        status: 'failed',
        error: `fanout step ${step.id} input.itemsFrom must resolve to an array`
      };
    }

    const childRuns: WorkflowStepRun[] = [];
    for (let index = 0; index < items.length; index++) {
      if (context.token.isCancellationRequested) {
        return {
          status: 'cancelled',
          childRuns
        };
      }

      const item = items[index];
      const childStepRunId = this.createChildStepRunId(step.id, input.step.id, item, index);
      const { stepRun, result } = await context.executeChildStep(input.step, childStepRunId, {
        item,
        index,
        stepRunId: childStepRunId
      });
      childRuns.push(stepRun);

      if (result.status !== 'succeeded') {
        return {
          status: result.status,
          error: result.error,
          blockedReason: result.blockedReason,
          childRuns
        };
      }
    }

    return {
      status: 'succeeded',
      childRuns,
      output: childRuns
    };
  }

  private createChildStepRunId(parentStepId: string, childStepId: string, item: unknown, index: number): string {
    const key = this.itemKey(item);
    return key
      ? `${parentStepId}.${childStepId}_${key}_${index}`
      : `${parentStepId}.${childStepId}_${index}`;
  }

  private itemKey(item: unknown): string | undefined {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const maybeNumber = (item as Record<string, unknown>).number;
    if (typeof maybeNumber === 'number' || typeof maybeNumber === 'string') {
      return String(maybeNumber).replace(/[^A-Za-z0-9_-]/g, '_');
    }
    return undefined;
  }
}
