import { WorkflowStep, WorkflowStepRun } from '../types';
import { getVariable } from './variableResolver';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';

interface FanoutInput {
  itemsFrom?: string;
  step?: WorkflowStep;
  steps?: WorkflowStep[];
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
    const childSteps = this.getChildSteps(input);
    if (childSteps.length === 0) {
      return {
        status: 'failed',
        error: `fanout step ${step.id} requires input.step or input.steps`
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
      const itemVariables: Record<string, unknown> = {
        item,
        index,
        steps: this.copyParentStepVariables(context.variables.steps)
      };

      for (const childStep of childSteps) {
        const childStepRunId = this.createChildStepRunId(step.id, childStep.id, item, index);
        const { stepRun, result } = await context.executeChildStep(childStep, childStepRunId, {
          ...itemVariables,
          stepRunId: childStepRunId
        });
        childRuns.push(stepRun);
        this.recordChildStepOutput(itemVariables, childStep.id, result);

        if (result.status !== 'succeeded') {
          return {
            status: result.status,
            error: result.error,
            blockedReason: result.blockedReason,
            childRuns
          };
        }
      }
    }

    return {
      status: 'succeeded',
      childRuns,
      output: childRuns
    };
  }

  private getChildSteps(input: FanoutInput): WorkflowStep[] {
    if (Array.isArray(input.steps)) {
      return input.steps;
    }
    return input.step ? [input.step] : [];
  }

  private copyParentStepVariables(steps: unknown): Record<string, unknown> {
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
      return {};
    }
    return { ...(steps as Record<string, unknown>) };
  }

  private recordChildStepOutput(variables: Record<string, unknown>, stepId: string, result: StepExecutionResult): void {
    const steps = this.copyParentStepVariables(variables.steps);
    variables.steps = {
      ...steps,
      [stepId]: {
        output: result.output,
        outputArtifact: result.outputArtifact,
        status: result.status
      }
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
