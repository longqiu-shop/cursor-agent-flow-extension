import { v4 as uuidv4 } from 'uuid';
import {
  StepStatus,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunTrigger,
  WorkflowStatus,
  WorkflowStep,
  WorkflowStepRun,
  WorkflowStepType
} from '../types';
import { ArtifactStore } from './artifactStore';
import { RunningWorkflowRegistry } from './runningWorkflowRegistry';
import { WorkflowCancellationController } from './workflowCancellation';
import { createWorkflowRunDir, saveWorkflowRunAtomic } from './workflowRunStore';
import { WorkflowVariables } from './variableResolver';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export interface WorkflowExecutionContext {
  workflow: WorkflowDefinition;
  run: WorkflowRun;
  artifactStore: ArtifactStore;
  variables: WorkflowVariables;
  token: import('vscode').CancellationToken;
  executeChildStep(
    step: WorkflowStep,
    stepRunId: string,
    variables: WorkflowVariables
  ): Promise<{ stepRun: WorkflowStepRun; result: StepExecutionResult }>;
}

export interface StepExecutionResult {
  status: StepStatus;
  outputArtifact?: string;
  error?: string;
  blockedReason?: string;
  childRuns?: WorkflowStepRun[];
  output?: unknown;
}

export interface WorkflowStepExecutor {
  readonly type: WorkflowStepType;
  execute(step: WorkflowStep, stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult>;
}

export interface WorkflowRunOptions {
  scheduleId?: string;
  trigger?: WorkflowRunTrigger;
  variables?: WorkflowVariables;
}

interface ActiveWorkflowRun {
  run: WorkflowRun;
  cancellation: WorkflowCancellationController;
}

interface WorkflowExecutionState {
  run: WorkflowRun;
  cancellation: WorkflowCancellationController;
  context: WorkflowExecutionContext;
}

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'succeeded',
  'failed',
  'timedOut',
  'interrupted',
  'cancelled'
]);

export class WorkflowRunner {
  private executors = new Map<WorkflowStepType, WorkflowStepExecutor>();
  private activeRuns = new Map<string, ActiveWorkflowRun>();

  constructor(
    private readonly runningWorkflowRegistry: RunningWorkflowRegistry,
    private readonly schemaRegistry: WorkflowSchemaRegistry,
    executors: WorkflowStepExecutor[]
  ) {
    for (const executor of executors) {
      this.executors.set(executor.type, executor);
    }
  }

  start(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): WorkflowRun {
    const state = this.createExecutionState(workflow, options);
    this.executeRun(state).catch(error => this.failStartedRun(state.run, error));
    return state.run;
  }

  async run(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<WorkflowRun> {
    return this.executeRun(this.createExecutionState(workflow, options));
  }

  private createExecutionState(workflow: WorkflowDefinition, options: WorkflowRunOptions): WorkflowExecutionState {
    const run = this.createInitialRun(workflow, options);
    const cancellation = new WorkflowCancellationController();
    const artifactStore = new ArtifactStore(run.runDir, this.schemaRegistry);
    const context: WorkflowExecutionContext = {
      workflow,
      run,
      artifactStore,
      variables: {
        workflow: {
          id: workflow.id,
          name: workflow.name
        },
        run: {
          id: run.id,
          dir: run.runDir
        },
        runDir: run.runDir,
        steps: {},
        ...(options.variables ?? {})
      },
      token: cancellation.token,
      executeChildStep: async (step, stepRunId, variables) => this.executeChildStep(step, stepRunId, context, variables)
    };

    this.activeRuns.set(run.id, { run, cancellation });
    this.runningWorkflowRegistry.add(run);
    return { run, cancellation, context };
  }

  private async executeRun(state: WorkflowExecutionState): Promise<WorkflowRun> {
    const { run, cancellation, context } = state;
    const workflow = context.workflow;

    try {
      run.status = 'running';
      this.persist(run);

      for (const step of workflow.steps) {
        if (cancellation.token.isCancellationRequested) {
          this.cancelPendingRun(run);
          break;
        }

        const stepRun = this.startStep(run, step);
        const result = await this.executeStep(step, stepRun, context);
        this.finishStep(stepRun, result);
        this.recordStepOutput(context, step.id, result);

        if (this.shouldStopAfterStep(workflow, step, result.status)) {
          run.status = this.workflowStatusForStepStatus(result.status);
          run.error = result.error ?? this.defaultErrorForStatus(result.status);
          run.finishedAt = new Date().toISOString();
          run.currentStepId = undefined;
          this.persist(run);
          break;
        }

        run.currentStepId = undefined;
        this.persist(run);
      }

      if (!TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
        run.status = 'succeeded';
        run.finishedAt = new Date().toISOString();
        run.currentStepId = undefined;
        this.persist(run);
      }

      return run;
    } finally {
      cancellation.dispose();
      this.activeRuns.delete(run.id);
    }
  }

  private failStartedRun(run: WorkflowRun, error: unknown): void {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date().toISOString();
    run.currentStepId = undefined;
    this.persist(run);
  }

  cancel(runId: string): boolean {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return false;
    }
    activeRun.cancellation.cancel();
    return true;
  }

  private createInitialRun(workflow: WorkflowDefinition, options: WorkflowRunOptions): WorkflowRun {
    const runId = `run_${Date.now()}_${uuidv4()}`;
    return {
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      scheduleId: options.scheduleId,
      trigger: options.trigger,
      status: 'pending',
      runDir: createWorkflowRunDir(runId),
      startedAt: new Date().toISOString(),
      steps: workflow.steps.map(step => ({
        stepRunId: step.id,
        definitionId: step.id,
        type: step.type,
        status: 'pending'
      }))
    };
  }

  private startStep(run: WorkflowRun, step: WorkflowStep): WorkflowStepRun {
    const stepRun = this.getStepRun(run, step.id);
    stepRun.status = 'running';
    stepRun.startedAt = new Date().toISOString();
    stepRun.error = undefined;
    run.currentStepId = step.id;
    this.persist(run);
    return stepRun;
  }

  private async executeStep(
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    context: WorkflowExecutionContext
  ): Promise<StepExecutionResult> {
    if (context.token.isCancellationRequested) {
      return { status: 'cancelled' };
    }

    const executor = this.executors.get(step.type);
    if (!executor) {
      return {
        status: 'failed',
        error: `No executor registered for workflow step type: ${step.type}`
      };
    }

    try {
      return await executor.execute(step, stepRun, context);
    } catch (error) {
      if (context.token.isCancellationRequested) {
        return { status: 'cancelled' };
      }
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private finishStep(stepRun: WorkflowStepRun, result: StepExecutionResult): void {
    stepRun.status = result.status;
    stepRun.finishedAt = new Date().toISOString();
    stepRun.outputArtifact = result.outputArtifact;
    stepRun.error = result.error;
    stepRun.blockedReason = result.blockedReason;
    stepRun.childRuns = result.childRuns;
  }

  private async executeChildStep(
    step: WorkflowStep,
    stepRunId: string,
    parentContext: WorkflowExecutionContext,
    variables: WorkflowVariables
  ): Promise<{ stepRun: WorkflowStepRun; result: StepExecutionResult }> {
    const childRun: WorkflowStepRun = {
      stepRunId,
      definitionId: step.id,
      type: step.type,
      status: 'running',
      startedAt: new Date().toISOString()
    };
    const context: WorkflowExecutionContext = {
      ...parentContext,
      variables: {
        ...parentContext.variables,
        ...variables
      }
    };

    const result = await this.executeStep(step, childRun, context);
    this.finishStep(childRun, result);
    return { stepRun: childRun, result };
  }

  private recordStepOutput(context: WorkflowExecutionContext, stepId: string, result: StepExecutionResult): void {
    const variables = context.variables as Record<string, unknown>;
    const existingSteps = variables.steps && typeof variables.steps === 'object'
      ? variables.steps as Record<string, unknown>
      : {};

    variables.steps = {
      ...existingSteps,
      [stepId]: {
        output: result.output,
        outputArtifact: result.outputArtifact,
        status: result.status
      }
    };
  }

  private shouldStopAfterStep(workflow: WorkflowDefinition, step: WorkflowStep, status: StepStatus): boolean {
    if (status === 'succeeded') {
      return false;
    }

    if (status === 'cancelled' || status === 'blocked' || status === 'timedOut' || status === 'interrupted') {
      return true;
    }

    const required = step.required !== false;
    if (required) {
      return true;
    }

    return workflow.defaults?.onStepFailure !== 'continue';
  }

  private workflowStatusForStepStatus(status: StepStatus): WorkflowStatus {
    switch (status) {
      case 'blocked':
      case 'cancelled':
      case 'timedOut':
      case 'interrupted':
        return status;
      case 'succeeded':
        return 'succeeded';
      case 'pending':
      case 'running':
      case 'failed':
        return 'failed';
    }
  }

  private cancelPendingRun(run: WorkflowRun): void {
    run.status = 'cancelled';
    run.error = 'Workflow cancelled by user';
    run.finishedAt = new Date().toISOString();
    if (run.currentStepId) {
      const stepRun = this.getStepRun(run, run.currentStepId);
      stepRun.status = 'cancelled';
      stepRun.error = 'Workflow cancelled by user';
      stepRun.finishedAt = new Date().toISOString();
    }
    run.currentStepId = undefined;
    this.persist(run);
  }

  private getStepRun(run: WorkflowRun, stepId: string): WorkflowStepRun {
    const stepRun = run.steps.find(step => step.definitionId === stepId);
    if (!stepRun) {
      throw new Error(`Workflow run state missing step: ${stepId}`);
    }
    return stepRun;
  }

  private persist(run: WorkflowRun): void {
    saveWorkflowRunAtomic(run);
    this.runningWorkflowRegistry.update(run);
  }

  private defaultErrorForStatus(status: StepStatus): string | undefined {
    switch (status) {
      case 'blocked':
        return 'Workflow blocked waiting for user input';
      case 'cancelled':
        return 'Workflow cancelled by user';
      case 'timedOut':
        return 'Workflow timed out';
      case 'interrupted':
        return 'Workflow interrupted';
      default:
        return undefined;
    }
  }
}
