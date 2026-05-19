import * as fs from 'fs';
import * as path from 'path';
import { ArtifactSpec, StepStatusArtifact, WorkflowStep, WorkflowStepRun } from '../types';
import type { AgentCommandInvocationEvent, AgentSubmitOptions, AgentSubmitResult } from '../agent/cursorAgentRunner';
import { renderTemplate } from './variableResolver';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import type { ArtifactWaitResult } from './artifactStore';
import { STEP_STATUS_SCHEMA_ID } from './workflowSchemas';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';
import { sha256 } from './plannerContractResolver';
import { MASTER_PLAN_SCHEMA_ID } from './planSchemas';

const FIRST_STARTED_MARKER_TIMEOUT_MS = 30000;
const RETRY_STARTED_MARKER_TIMEOUT_MS = 60000;
const MAX_SUBMISSION_ATTEMPTS = 2;

interface AgentStepInput {
  title?: string;
  prompt?: string;
  promptFile?: string;
  freshChat?: boolean;
  submitMode?: 'worktree' | 'currentWorkspace';
  promptArtifact?: string;
  statusArtifact?: string;
  startedArtifact?: string;
  stageId?: string;
  taskId?: string;
}

interface AgentPromptRunner {
  submitPrompt(prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult>;
}

interface AgentSubmissionQueue {
  enqueue<T>(run: () => Promise<T>, token?: WorkflowExecutionContext['token']): Promise<T>;
}

interface SubmissionDebugArtifact {
  schemaVersion: '1';
  submissionId: string;
  checkpoint: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepRunId: string;
  definitionId: string;
  stageId?: string;
  taskId?: string;
  title: string;
  freshChat: boolean;
  submitMode: 'worktree' | 'currentWorkspace';
  queuedAt: string;
  submittingAt?: string;
  submittedAt?: string;
  completedAt?: string;
  queueWaitMs?: number;
  promptSha256: string;
  promptArtifact?: string;
  submissionDebugArtifact: string;
  expectedArtifact: string;
  expectedArtifactAbsolute: string;
  startedArtifact: string;
  startedArtifactAbsolute: string;
  statusArtifact: string;
  statusArtifactAbsolute: string;
  correlationMarker: string;
  commands: AgentCommandInvocationEvent[];
  attempts: SubmissionAttemptDebugArtifact[];
  resultStatus?: string;
  resultOutput?: string;
  failureCategory?: string;
  error?: string;
}

interface SubmissionAttemptDebugArtifact {
  attempt: number;
  submissionId: string;
  promptSha256: string;
  startedArtifact: string;
  startedArtifactAbsolute: string;
  expectedArtifact: string;
  expectedArtifactAbsolute: string;
  statusArtifact: string;
  statusArtifactAbsolute: string;
  markerTimeoutMs: number;
  submittedAt?: string;
  startedAt?: string;
  markerStatus?: 'found' | 'timeout' | 'cancelled';
  error?: string;
}

interface SubmissionAttempt {
  attempt: number;
  submissionId: string;
  prompt: string;
  promptSha256: string;
  outputSpec: ArtifactSpec;
  outputPath: string;
  statusSpec: ArtifactSpec;
  statusPath: string;
  startedSpec: ArtifactSpec;
  startedPath: string;
  correlationMarker: string;
  traceRefs: Record<string, unknown>;
  markerTimeoutMs: number;
}

class SimpleCancellationTokenSource {
  private listeners: Array<() => void> = [];
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter(item => item !== listener);
        }
      };
    }
  };

  cancel(): void {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.token.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class AgentStepExecutor implements WorkflowStepExecutor {
  readonly type = 'agent' as const;

  constructor(
    private readonly runner: AgentPromptRunner,
    private readonly submissionQueue: AgentSubmissionQueue
  ) {}

  async execute(step: WorkflowStep, stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const input = step.input as AgentStepInput | undefined;
    const promptTemplate = this.getPromptTemplate(step, input, context);
    if (!promptTemplate.ok) {
      return {
        status: 'failed',
        error: promptTemplate.error
      };
    }
    if (!step.output) {
      return {
        status: 'failed',
        error: `agent step ${step.id} requires an output artifact`
      };
    }
    const outputSpec = step.output;

    const title = input?.title ? renderTemplate(input.title, context.variables) : step.name ?? step.id;
    const statusSpec: ArtifactSpec = {
      path: input?.statusArtifact ?? `status/${stepRun.stepRunId}.json`,
      format: 'json',
      schema: STEP_STATUS_SCHEMA_ID
    };
    const startedSpec: ArtifactSpec = {
      path: input?.startedArtifact ?? this.buildStartedArtifactPath(outputSpec.path),
      format: 'json',
      schema: 'none'
    };
    stepRun.title = title;
    stepRun.promptPreview = promptTemplate.value.slice(0, 200);

    const renderedUserPrompt = renderTemplate(promptTemplate.value, context.variables);
    const submissionDebugArtifact = this.buildSubmissionDebugArtifactPath(input, outputSpec.path);
    const firstAttempt = this.buildSubmissionAttempt(
      context,
      step,
      stepRun,
      input,
      title,
      renderedUserPrompt,
      outputSpec,
      statusSpec,
      startedSpec,
      1
    );
    stepRun.expectedArtifact = firstAttempt.outputPath;
    const traceStore = new TraceStore(context.run.runDir);
    const plannerPromptRefs = this.persistPlannerPromptArtifacts(step, context, traceStore, renderedUserPrompt);
    const promptArtifactRefs = this.persistFinalPromptArtifact(input, context, traceStore, firstAttempt.prompt);
    const queuedAt = new Date().toISOString();
    const submissionDebug: SubmissionDebugArtifact = {
      schemaVersion: '1',
      submissionId: firstAttempt.submissionId,
      checkpoint: 'queued',
      runId: context.run.id,
      workflowId: context.run.workflowId,
      workflowName: context.run.workflowName,
      stepId: step.id,
      stepRunId: stepRun.stepRunId,
      definitionId: stepRun.definitionId,
      ...(input?.stageId ? { stageId: input.stageId } : {}),
      ...(input?.taskId ? { taskId: input.taskId } : {}),
      title,
      freshChat: input?.freshChat !== false,
      submitMode: input?.submitMode ?? 'worktree',
      queuedAt,
      promptSha256: firstAttempt.promptSha256,
      ...(input?.promptArtifact ? { promptArtifact: input.promptArtifact } : {}),
      submissionDebugArtifact,
      expectedArtifact: outputSpec.path,
      expectedArtifactAbsolute: firstAttempt.outputPath,
      startedArtifact: firstAttempt.startedSpec.path,
      startedArtifactAbsolute: firstAttempt.startedPath,
      statusArtifact: statusSpec.path,
      statusArtifactAbsolute: firstAttempt.statusPath,
      correlationMarker: firstAttempt.correlationMarker,
      commands: [],
      attempts: []
    };
    this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
    const queuedArtifacts = [
      ...(promptArtifactRefs ?? []),
      { path: submissionDebugArtifact, role: 'submissionDebug' }
    ];
    this.appendSubmissionEvent(traceStore, 'queued', firstAttempt.traceRefs, {
      freshChat: input?.freshChat !== false,
      submitMode: input?.submitMode ?? 'worktree',
      artifacts: queuedArtifacts
    });

    try {
      return await this.submissionQueue.enqueue(
        async () => {
          submissionDebug.submittingAt = new Date().toISOString();
          submissionDebug.queueWaitMs = Date.parse(submissionDebug.submittingAt) - Date.parse(submissionDebug.queuedAt);
          for (let attemptNumber = 1; attemptNumber <= MAX_SUBMISSION_ATTEMPTS; attemptNumber++) {
            const attempt = attemptNumber === 1
              ? firstAttempt
              : this.buildSubmissionAttempt(
                context,
                step,
                stepRun,
                input,
                title,
                renderedUserPrompt,
                outputSpec,
                statusSpec,
                startedSpec,
                attemptNumber
              );
            const attemptDebug = this.createAttemptDebug(attempt);
            submissionDebug.attempts.push(attemptDebug);
            submissionDebug.checkpoint = 'submitting';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'submitting', attempt.traceRefs);

            const submitResult = await this.runner.submitPrompt(attempt.prompt, {
              title,
              correlationId: attempt.submissionId,
              freshChat: input?.freshChat !== false,
              submitMode: input?.submitMode ?? 'worktree',
              attempt: attempt.attempt,
              onCommand: event => {
                submissionDebug.commands.push(event);
                submissionDebug.checkpoint = `command.${event.phase}`;
                this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
                this.appendCommandEvent(traceStore, attempt.traceRefs, event);
              }
            });

            attemptDebug.submittedAt = new Date().toISOString();
            if (!submitResult.success) {
              attemptDebug.error = submitResult.error || 'Failed to submit agent prompt';
              submissionDebug.resultOutput = submitResult.output;
              submissionDebug.checkpoint = 'submitFailed';
              this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
              this.appendSubmissionEvent(traceStore, 'submitFailed', attempt.traceRefs, {
                error: attemptDebug.error
              });
              if (attemptNumber < MAX_SUBMISSION_ATTEMPTS) {
                this.appendSubmissionEvent(traceStore, 'retrying', attempt.traceRefs, {
                  reason: 'submitFailed',
                  nextAttempt: attemptNumber + 1
                });
                continue;
              }
              return this.failSubmission(
                context,
                traceStore,
                submissionDebugArtifact,
                submissionDebug,
                attempt.traceRefs,
                'composerSubmit',
                attemptDebug.error
              );
            }

            submissionDebug.submittedAt = attemptDebug.submittedAt;
            submissionDebug.resultOutput = submitResult.output;
            submissionDebug.checkpoint = 'submitted';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'submitted', attempt.traceRefs, {
              attempt: attempt.attempt
            });
            if (attemptNumber === 1 && plannerPromptRefs) {
              traceStore.append('planner.promptSubmitted', plannerPromptRefs);
            }

            submissionDebug.checkpoint = 'waitingForStartedMarker';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'waitingForStartedMarker', attempt.traceRefs, {
              timeoutMs: attempt.markerTimeoutMs,
              artifacts: [{ path: attempt.startedSpec.path, role: 'started' }]
            });
            const startedResult = await this.waitForStartedMarker(attempt, context);
            attemptDebug.markerStatus = startedResult.status;
            if (startedResult.status === 'cancelled') {
              submissionDebug.completedAt = new Date().toISOString();
              submissionDebug.resultStatus = 'cancelled';
              submissionDebug.checkpoint = 'cancelled';
              this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
              this.appendSubmissionEvent(traceStore, 'cancelled', attempt.traceRefs);
              return { status: 'cancelled' };
            }
            if (startedResult.status === 'timeout') {
              attemptDebug.error = startedResult.error;
              this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
              this.appendSubmissionEvent(traceStore, 'startedMarkerMissing', attempt.traceRefs, {
                error: startedResult.error,
                timeoutMs: attempt.markerTimeoutMs
              });
              if (attemptNumber < MAX_SUBMISSION_ATTEMPTS) {
                this.appendSubmissionEvent(traceStore, 'retrying', attempt.traceRefs, {
                  reason: 'startedMarkerMissing',
                  nextAttempt: attemptNumber + 1
                });
                continue;
              }
              return this.failSubmission(
                context,
                traceStore,
                submissionDebugArtifact,
                submissionDebug,
                attempt.traceRefs,
                'notStarted',
                startedResult.error || 'Agent did not write a started marker after retry'
              );
            }

            attemptDebug.startedAt = new Date().toISOString();
            submissionDebug.checkpoint = 'started';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'started', attempt.traceRefs, {
              artifacts: [{ path: attempt.startedSpec.path, role: 'started' }]
            });
            submissionDebug.checkpoint = 'waitingForArtifact';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'waitingForArtifact', attempt.traceRefs, {
              artifacts: [
                { path: attempt.outputSpec.path, role: 'output' },
                { path: attempt.statusSpec.path, role: 'status' }
              ]
            });
            const waitResult = await this.waitForOutputOrStatus(attempt.outputSpec, attempt.statusSpec, context);
            return this.resultFromArtifactWait(
              waitResult,
              attempt,
              context,
              traceStore,
              submissionDebugArtifact,
              submissionDebug
            );
          }

          return this.failSubmission(
            context,
            traceStore,
            submissionDebugArtifact,
            submissionDebug,
            firstAttempt.traceRefs,
            'notStarted',
            'Agent did not write a started marker'
          );
        },
        context.token
      );
    } catch (error) {
      submissionDebug.completedAt = new Date().toISOString();
      submissionDebug.resultStatus = 'failed';
      submissionDebug.error = error instanceof Error ? error.message : String(error);
      submissionDebug.checkpoint = 'failed';
      this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
      this.appendSubmissionEvent(traceStore, 'failed', firstAttempt.traceRefs, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private createAttemptDebug(attempt: SubmissionAttempt): SubmissionAttemptDebugArtifact {
    return {
      attempt: attempt.attempt,
      submissionId: attempt.submissionId,
      promptSha256: attempt.promptSha256,
      startedArtifact: attempt.startedSpec.path,
      startedArtifactAbsolute: attempt.startedPath,
      expectedArtifact: attempt.outputSpec.path,
      expectedArtifactAbsolute: attempt.outputPath,
      statusArtifact: attempt.statusSpec.path,
      statusArtifactAbsolute: attempt.statusPath,
      markerTimeoutMs: attempt.markerTimeoutMs
    };
  }

  private failSubmission(
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    submissionDebugArtifact: string,
    submissionDebug: SubmissionDebugArtifact,
    traceRefs: Record<string, unknown>,
    failureCategory: string,
    error: string
  ): StepExecutionResult {
    submissionDebug.completedAt = new Date().toISOString();
    submissionDebug.resultStatus = 'failed';
    submissionDebug.failureCategory = failureCategory;
    submissionDebug.error = error;
    submissionDebug.checkpoint = 'failed';
    this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
    this.appendSubmissionEvent(traceStore, 'failed', traceRefs, {
      failureCategory,
      error
    });
    return {
      status: 'failed',
      error
    };
  }

  private async waitForStartedMarker(
    attempt: SubmissionAttempt,
    context: WorkflowExecutionContext
  ): Promise<{
    status: 'found' | 'timeout' | 'cancelled';
    error?: string;
  }> {
    const result = await context.artifactStore.waitForArtifact(attempt.startedSpec, context.variables, {
      timeoutMs: attempt.markerTimeoutMs,
      token: context.token,
      initialIntervalMs: 1000,
      maxIntervalMs: 2000,
      backoffAfterMs: attempt.markerTimeoutMs + 1
    });
    if (context.token.isCancellationRequested || result.status === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (result.status === 'found') {
      return { status: 'found' };
    }
    return {
      status: 'timeout',
      error: result.errors?.join('; ') || `Agent did not write started marker within ${attempt.markerTimeoutMs / 1000}s`
    };
  }

  private resultFromArtifactWait(
    waitResult: {
      status: 'found' | 'timeout' | 'cancelled';
      statusArtifact?: boolean;
      value?: unknown;
      error?: string;
    },
    attempt: SubmissionAttempt,
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    submissionDebugArtifact: string,
    submissionDebug: SubmissionDebugArtifact
  ): StepExecutionResult {
    if (waitResult.status === 'cancelled') {
      submissionDebug.completedAt = new Date().toISOString();
      submissionDebug.resultStatus = 'cancelled';
      submissionDebug.checkpoint = 'cancelled';
      this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
      this.appendSubmissionEvent(traceStore, 'cancelled', attempt.traceRefs);
      return { status: 'cancelled' };
    }
    if (waitResult.status === 'timeout') {
      submissionDebug.completedAt = new Date().toISOString();
      submissionDebug.resultStatus = 'timedOut';
      submissionDebug.error = waitResult.error;
      submissionDebug.failureCategory = 'artifactTimeout';
      submissionDebug.checkpoint = 'artifactWaitTimedOut';
      this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
      this.appendSubmissionEvent(traceStore, 'artifactWaitTimedOut', attempt.traceRefs, {
        error: waitResult.error
      });
      return {
        status: 'timedOut',
        error: waitResult.error
      };
    }
    if (waitResult.statusArtifact) {
      const statusArtifact = waitResult.value as StepStatusArtifact;
      submissionDebug.completedAt = new Date().toISOString();
      submissionDebug.resultStatus = statusArtifact.status === 'blocked' ? 'blocked' : 'failed';
      submissionDebug.error = statusArtifact.reason;
      submissionDebug.checkpoint = 'statusArtifactFound';
      this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
      this.appendSubmissionEvent(traceStore, 'statusArtifactFound', attempt.traceRefs, {
        status: statusArtifact.status,
        reason: statusArtifact.reason,
        artifacts: [{ path: attempt.statusSpec.path, role: 'status' }]
      });
      return {
        status: statusArtifact.status === 'blocked' ? 'blocked' : 'failed',
        blockedReason: statusArtifact.status === 'blocked' ? statusArtifact.reason : undefined,
        error: statusArtifact.status === 'failed' ? statusArtifact.reason : undefined,
        outputArtifact: attempt.statusPath
      };
    }

    submissionDebug.completedAt = new Date().toISOString();
    submissionDebug.resultStatus = 'succeeded';
    submissionDebug.checkpoint = 'artifactFound';
    this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
    this.appendSubmissionEvent(traceStore, 'artifactFound', attempt.traceRefs, {
      artifacts: [{ path: attempt.outputSpec.path, role: 'output' }]
    });
    if (attempt.outputSpec.schema === MASTER_PLAN_SCHEMA_ID) {
      traceStore.appendTyped(TRACE_EVENTS.PLAN_CREATED, {
        artifacts: [{ path: attempt.outputSpec.path, role: 'masterPlan' }]
      });
    }
    return {
      status: 'succeeded',
      outputArtifact: attempt.outputPath,
      output: waitResult.value
    };
  }

  private persistFinalPromptArtifact(
    input: AgentStepInput | undefined,
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    prompt: string
  ): Array<{ path: string; role: string; hash?: string }> | undefined {
    if (!input?.promptArtifact) {
      return undefined;
    }

    const hash = sha256(prompt);
    context.artifactStore.writeText(input.promptArtifact, prompt, context.variables);
    const artifacts = [{ path: input.promptArtifact, role: 'finalSubmittedPrompt', hash }];
    if (input.stageId && input.taskId) {
      traceStore.appendTyped(TRACE_EVENTS.AGENT_PROMPTED, {
        stageId: input.stageId,
        taskId: input.taskId,
        promptSha256: hash,
        artifacts
      });
    }
    return artifacts;
  }

  private async waitForOutputOrStatus(
    outputSpec: ArtifactSpec,
    statusSpec: ArtifactSpec,
    context: WorkflowExecutionContext
  ): Promise<{
    status: 'found' | 'timeout' | 'cancelled';
    statusArtifact?: boolean;
    value?: unknown;
    error?: string;
  }> {
    const timeoutMs = context.workflow.defaults?.timeoutSeconds
      ? context.workflow.defaults.timeoutSeconds * 1000
      : 600000;

    const waitTokenSource = new SimpleCancellationTokenSource();
    const parentCancellation = context.token.onCancellationRequested(() => waitTokenSource.cancel());

    try {
      const waitToken = waitTokenSource.token as unknown as WorkflowExecutionContext['token'];
      const waitResult = await Promise.race([
        context.artifactStore.waitForArtifact(outputSpec, context.variables, { timeoutMs, token: waitToken })
          .then(result => ({ kind: 'output' as const, result })),
        context.artifactStore.waitForArtifact<StepStatusArtifact>(statusSpec, context.variables, { timeoutMs, token: waitToken })
          .then(result => ({ kind: 'status' as const, result }))
      ]);
      waitTokenSource.cancel();

      if (context.token.isCancellationRequested || waitResult.result.status === 'cancelled') {
        return { status: 'cancelled' };
      }

      if (waitResult.result.status === 'found') {
        return this.toFoundWaitResult(waitResult.kind, waitResult.result);
      }

      return {
        status: 'timeout',
        error: waitResult.result.errors?.join('; ') || 'Agent step timed out waiting for artifact'
      };
    } finally {
      parentCancellation.dispose();
      waitTokenSource.dispose();
    }
  }

  private toFoundWaitResult(
    kind: 'output' | 'status',
    result: ArtifactWaitResult<unknown>
  ): {
    status: 'found';
    statusArtifact?: boolean;
    value?: unknown;
  } {
    if (kind === 'status') {
      return {
        status: 'found',
        statusArtifact: true,
        value: result.value
      };
    }

    return {
      status: 'found',
      value: result.value ?? result.content
    };
  }

  private getPromptTemplate(
    step: WorkflowStep,
    input: AgentStepInput | undefined,
    context: WorkflowExecutionContext
  ): { ok: true; value: string } | { ok: false; error: string } {
    const prompt = input?.prompt;
    const promptFile = input?.promptFile;

    if (prompt && promptFile) {
      return {
        ok: false,
        error: `agent step ${step.id} must use either input.prompt or input.promptFile, not both`
      };
    }

    if (prompt) {
      return { ok: true, value: prompt };
    }

    if (!promptFile) {
      return {
        ok: false,
        error: `agent step ${step.id} requires input.prompt or input.promptFile`
      };
    }

    let promptFilePath: string;
    try {
      promptFilePath = this.resolvePromptFilePath(context.workflow.filePath, promptFile);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const content = this.readFileSafe(promptFilePath);
    if (content === undefined) {
      return {
        ok: false,
        error: `agent step ${step.id} could not read input.promptFile: ${promptFilePath}`
      };
    }

    return { ok: true, value: content.trim() };
  }

  private buildSubmissionAttempt(
    context: WorkflowExecutionContext,
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    input: AgentStepInput | undefined,
    title: string,
    renderedUserPrompt: string,
    outputSpec: ArtifactSpec,
    statusSpec: ArtifactSpec,
    startedSpec: ArtifactSpec,
    attempt: number
  ): SubmissionAttempt {
    const attemptOutputSpec: ArtifactSpec = {
      ...outputSpec,
      path: this.buildAttemptArtifactPath(outputSpec.path, attempt)
    };
    const attemptStatusSpec: ArtifactSpec = {
      ...statusSpec,
      path: this.buildAttemptArtifactPath(statusSpec.path, attempt)
    };
    const attemptStartedSpec: ArtifactSpec = {
      ...startedSpec,
      path: this.buildAttemptArtifactPath(startedSpec.path, attempt)
    };
    const outputPath = context.artifactStore.resolveArtifactPath(attemptOutputSpec.path, context.variables);
    const statusPath = context.artifactStore.resolveArtifactPath(attemptStatusSpec.path, context.variables);
    const startedPath = context.artifactStore.resolveArtifactPath(attemptStartedSpec.path, context.variables);
    const submissionId = this.buildSubmissionId(context.run.id, `${stepRun.stepRunId}.attempt-${attempt}`, renderedUserPrompt);
    const correlationMarker = this.buildCorrelationMarker(
      context,
      step,
      stepRun,
      title,
      submissionId,
      outputPath,
      statusPath,
      startedPath,
      attempt
    );
    const prompt = this.buildPrompt(
      renderedUserPrompt,
      outputPath,
      statusPath,
      startedPath,
      outputSpec.format,
      correlationMarker,
      attempt
    );
    const traceRefs = this.buildTraceRefs(
      step,
      stepRun,
      title,
      outputPath,
      statusPath,
      startedPath,
      submissionId,
      this.buildSubmissionDebugArtifactPath(input, outputSpec.path),
      attempt
    );
    return {
      attempt,
      submissionId,
      prompt,
      promptSha256: sha256(prompt),
      outputSpec: attemptOutputSpec,
      outputPath,
      statusSpec: attemptStatusSpec,
      statusPath,
      startedSpec: attemptStartedSpec,
      startedPath,
      correlationMarker,
      traceRefs,
      markerTimeoutMs: attempt === 1 ? FIRST_STARTED_MARKER_TIMEOUT_MS : RETRY_STARTED_MARKER_TIMEOUT_MS
    };
  }

  private buildStartedArtifactPath(outputArtifact: string): string {
    const normalized = outputArtifact.replace(/\\/g, '/');
    const parsed = path.posix.parse(normalized);
    const baseName = parsed.ext
      ? `${parsed.name}.started.json`
      : `${parsed.base}.started.json`;
    return parsed.dir ? path.posix.join(parsed.dir, baseName) : baseName;
  }

  private buildAttemptArtifactPath(artifactPath: string, attempt: number): string {
    if (attempt === 1) {
      return artifactPath;
    }

    const normalized = artifactPath.replace(/\\/g, '/');
    const parsed = path.posix.parse(normalized);
    const suffix = `.attempt-${attempt}`;
    const baseName = parsed.ext
      ? `${parsed.name}${suffix}${parsed.ext}`
      : `${parsed.base}${suffix}`;
    return parsed.dir ? path.posix.join(parsed.dir, baseName) : baseName;
  }

  private buildTraceRefs(
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    title: string,
    outputPath: string,
    statusPath: string,
    startedPath: string,
    submissionId: string,
    submissionDebugArtifact: string,
    attempt: number
  ): Record<string, unknown> {
    return {
      stepId: step.id,
      stepRunId: stepRun.stepRunId,
      definitionId: stepRun.definitionId,
      title,
      attempt,
      submissionId,
      expectedArtifact: outputPath,
      statusArtifact: statusPath,
      startedArtifact: startedPath,
      submissionDebugArtifact
    };
  }

  private appendSubmissionEvent(
    traceStore: TraceStore,
    checkpoint: string,
    traceRefs: Record<string, unknown>,
    refs: Record<string, unknown> = {}
  ): void {
    traceStore.append(`agentSubmission.${checkpoint}`, {
      ...traceRefs,
      checkpoint,
      ...refs
    });
  }

  private appendCommandEvent(
    traceStore: TraceStore,
    traceRefs: Record<string, unknown>,
    event: AgentCommandInvocationEvent
  ): void {
    traceStore.append('agentSubmission.command', {
      ...traceRefs,
      command: event.command,
      phase: event.phase,
      commandTimestamp: event.timestamp,
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.argumentsSummary ? { argumentsSummary: event.argumentsSummary } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      ...(event.error ? { error: event.error } : {})
    });
  }

  private persistSubmissionDebug(
    context: WorkflowExecutionContext,
    submissionDebugArtifact: string,
    value: SubmissionDebugArtifact
  ): void {
    context.artifactStore.writeText(submissionDebugArtifact, `${JSON.stringify(value, null, 2)}\n`, context.variables);
  }

  private persistPlannerPromptArtifacts(
    step: WorkflowStep,
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    renderedPrompt: string
  ): Record<string, unknown> | undefined {
    const plannerContract = context.workflow.plannerContract;
    if (step.id !== 'planner' || !plannerContract) {
      return undefined;
    }

    const plannerDir = path.join(context.run.runDir, 'planner');
    const promptPath = path.join(plannerDir, 'prompt.md');
    const metadataPath = path.join(plannerDir, 'prompt-metadata.json');
    const promptHash = sha256(renderedPrompt);
    const metadata = {
      ...plannerContract,
      renderedPromptSha256: promptHash,
      artifacts: {
        prompt: 'planner/prompt.md',
        metadata: 'planner/prompt-metadata.json'
      }
    };

    fs.mkdirSync(plannerDir, { recursive: true });
    fs.writeFileSync(promptPath, renderedPrompt, 'utf-8');
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');

    const refs = {
      ...plannerContract,
      renderedPromptSha256: promptHash,
      artifacts: [
        { path: 'planner/prompt.md', role: 'plannerPrompt', hash: promptHash },
        { path: 'planner/prompt-metadata.json', role: 'plannerPromptMetadata' }
      ]
    };
    traceStore.append('planner.contractResolved', refs);
    traceStore.append('planner.promptRendered', refs);
    return refs;
  }

  private readFileSafe(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  private resolvePromptFilePath(workflowFilePath: string, promptFile: string): string {
    if (path.isAbsolute(promptFile)) {
      throw new Error(`agent promptFile must be relative to the workflow file: ${promptFile}`);
    }

    const normalized = path.normalize(promptFile);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
      const workflowDir = path.dirname(workflowFilePath);
      const assetsDir = path.dirname(workflowDir);
      const resolvedPromptPath = path.resolve(workflowDir, normalized);
      const relativeToAssets = path.relative(assetsDir, resolvedPromptPath);
      const allowedExtensionAssetPath = path.basename(workflowDir) === 'workflows'
        && path.basename(assetsDir) === 'assets'
        && relativeToAssets.length > 0
        && !relativeToAssets.startsWith('..')
        && !path.isAbsolute(relativeToAssets);
      if (!allowedExtensionAssetPath) {
        throw new Error(`agent promptFile must not traverse outside the workflow directory: ${promptFile}`);
      }
    }

    return path.resolve(path.dirname(workflowFilePath), promptFile);
  }

  private buildPrompt(
    userPrompt: string,
    outputPath: string,
    statusPath: string,
    startedPath: string,
    outputFormat: ArtifactSpec['format'],
    correlationMarker: string,
    attempt: number
  ): string {
    return [
      userPrompt,
      '',
      correlationMarker,
      '',
      'Workflow step output contract:',
      '',
      'Before doing any other work, write this JSON started marker to:',
      startedPath,
      '',
      '{',
      '  "status": "started",',
      `  "attempt": ${attempt},`,
      '  "startedAt": "CURRENT_ISO_TIMESTAMP"',
      '}',
      '',
      'Write your final result by first writing the complete content to:',
      `${outputPath}.tmp`,
      '',
      'Then rename that file to:',
      outputPath,
      '',
      'If you need human input and cannot continue, write this JSON to:',
      statusPath,
      '',
      '{',
      '  "status": "blocked",',
      '  "reason": "Explain what input is needed"',
      '}',
      '',
      `The final output format must be ${outputFormat}.`,
      'Do not write partial JSON to the final output path. For JSON outputs, write valid JSON only.'
    ].join('\n');
  }

  private buildSubmissionId(runId: string, stepRunId: string, renderedPrompt: string): string {
    return [
      this.safeSubmissionPart(runId),
      this.safeSubmissionPart(stepRunId),
      sha256(renderedPrompt).slice(0, 12)
    ].join('.');
  }

  private safeSubmissionPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  }

  private buildSubmissionDebugArtifactPath(input: AgentStepInput | undefined, outputArtifact: string): string {
    const siblingArtifact = input?.promptArtifact ?? outputArtifact;
    const directory = path.posix.dirname(siblingArtifact.replace(/\\/g, '/'));
    if (directory === '.') {
      return 'submission-debug.json';
    }
    return path.posix.join(directory, 'submission-debug.json');
  }

  private buildCorrelationMarker(
    context: WorkflowExecutionContext,
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    title: string,
    submissionId: string,
    outputPath: string,
    statusPath: string,
    startedPath: string,
    attempt: number
  ): string {
    return [
      'Workflow agent correlation:',
      `- Submission ID: ${submissionId}`,
      `- Attempt: ${attempt}`,
      `- Run ID: ${context.run.id}`,
      `- Workflow ID: ${context.run.workflowId}`,
      `- Step ID: ${step.id}`,
      `- Step Run ID: ${stepRun.stepRunId}`,
      `- Title: ${title}`,
      `- Expected output artifact: ${outputPath}`,
      `- Status artifact: ${statusPath}`,
      `- Started marker artifact: ${startedPath}`,
      'Use this block to match the visible Cursor chat/Composer run back to the workflow trace.'
    ].join('\n');
  }
}
