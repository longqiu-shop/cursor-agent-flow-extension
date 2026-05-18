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

interface AgentStepInput {
  title?: string;
  prompt?: string;
  promptFile?: string;
  freshChat?: boolean;
  submitMode?: 'worktree' | 'currentWorkspace';
  promptArtifact?: string;
  statusArtifact?: string;
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
  statusArtifact: string;
  statusArtifactAbsolute: string;
  correlationMarker: string;
  commands: AgentCommandInvocationEvent[];
  resultStatus?: string;
  resultOutput?: string;
  error?: string;
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
    const outputPath = context.artifactStore.resolveArtifactPath(outputSpec.path, context.variables);
    const statusSpec: ArtifactSpec = {
      path: input?.statusArtifact ?? `status/${stepRun.stepRunId}.json`,
      format: 'json',
      schema: STEP_STATUS_SCHEMA_ID
    };
    const statusPath = context.artifactStore.resolveArtifactPath(statusSpec.path, context.variables);
    stepRun.title = title;
    stepRun.promptPreview = promptTemplate.value.slice(0, 200);
    stepRun.expectedArtifact = outputPath;

    const renderedUserPrompt = renderTemplate(promptTemplate.value, context.variables);
    const submissionId = this.buildSubmissionId(context.run.id, stepRun.stepRunId, renderedUserPrompt);
    const submissionDebugArtifact = this.buildSubmissionDebugArtifactPath(input, outputSpec.path);
    const correlationMarker = this.buildCorrelationMarker(
      context,
      step,
      stepRun,
      title,
      submissionId,
      outputPath,
      statusPath
    );
    const traceStore = new TraceStore(context.run.runDir);
    const traceRefs = this.buildTraceRefs(step, stepRun, title, outputPath, statusPath, submissionId, submissionDebugArtifact);
    const plannerPromptRefs = this.persistPlannerPromptArtifacts(step, context, traceStore, renderedUserPrompt);
    const prompt = this.buildPrompt(renderedUserPrompt, outputPath, statusPath, outputSpec.format, correlationMarker);
    const promptSha256 = sha256(prompt);
    const promptArtifactRefs = this.persistFinalPromptArtifact(input, context, traceStore, prompt);
    const queuedAt = new Date().toISOString();
    const submissionDebug: SubmissionDebugArtifact = {
      schemaVersion: '1',
      submissionId,
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
      promptSha256,
      ...(input?.promptArtifact ? { promptArtifact: input.promptArtifact } : {}),
      submissionDebugArtifact,
      expectedArtifact: outputSpec.path,
      expectedArtifactAbsolute: outputPath,
      statusArtifact: statusSpec.path,
      statusArtifactAbsolute: statusPath,
      correlationMarker,
      commands: []
    };
    this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
    const queuedArtifacts = [
      ...(promptArtifactRefs ?? []),
      { path: submissionDebugArtifact, role: 'submissionDebug' }
    ];
    this.appendSubmissionEvent(traceStore, 'queued', traceRefs, {
      freshChat: input?.freshChat !== false,
      submitMode: input?.submitMode ?? 'worktree',
      artifacts: queuedArtifacts
    });

    try {
      return await this.submissionQueue.enqueue(
        async () => {
          submissionDebug.submittingAt = new Date().toISOString();
          submissionDebug.queueWaitMs = Date.parse(submissionDebug.submittingAt) - Date.parse(submissionDebug.queuedAt);
          submissionDebug.checkpoint = 'submitting';
          this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
          this.appendSubmissionEvent(traceStore, 'submitting', traceRefs);
          const submitResult = await this.runner.submitPrompt(prompt, {
            title,
            correlationId: submissionId,
            freshChat: input?.freshChat !== false,
            submitMode: input?.submitMode ?? 'worktree',
            onCommand: event => {
              submissionDebug.commands.push(event);
              submissionDebug.checkpoint = `command.${event.phase}`;
              this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
              this.appendCommandEvent(traceStore, traceRefs, event);
            }
          });

          if (!submitResult.success) {
            submissionDebug.completedAt = new Date().toISOString();
            submissionDebug.resultStatus = 'failed';
            submissionDebug.error = submitResult.error || 'Failed to submit agent prompt';
            submissionDebug.resultOutput = submitResult.output;
            submissionDebug.checkpoint = 'failed';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'failed', traceRefs, {
              error: submitResult.error || 'Failed to submit agent prompt'
            });
            return {
              status: 'failed',
              error: submitResult.error || 'Failed to submit agent prompt'
            };
          }

          submissionDebug.submittedAt = new Date().toISOString();
          submissionDebug.resultOutput = submitResult.output;
          submissionDebug.checkpoint = 'submitted';
          this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
          this.appendSubmissionEvent(traceStore, 'submitted', traceRefs);
          if (plannerPromptRefs) {
            traceStore.append('planner.promptSubmitted', plannerPromptRefs);
          }
          submissionDebug.checkpoint = 'waitingForArtifact';
          this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
          this.appendSubmissionEvent(traceStore, 'waitingForArtifact', traceRefs, {
            artifacts: [
              { path: outputSpec.path, role: 'output' },
              { path: statusSpec.path, role: 'status' }
            ]
          });
          const waitResult = await this.waitForOutputOrStatus(outputSpec, statusSpec, context);
          if (waitResult.status === 'cancelled') {
            submissionDebug.completedAt = new Date().toISOString();
            submissionDebug.resultStatus = 'cancelled';
            submissionDebug.checkpoint = 'cancelled';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'cancelled', traceRefs);
            return { status: 'cancelled' };
          }
          if (waitResult.status === 'timeout') {
            submissionDebug.completedAt = new Date().toISOString();
            submissionDebug.resultStatus = 'timedOut';
            submissionDebug.error = waitResult.error;
            submissionDebug.checkpoint = 'artifactWaitTimedOut';
            this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
            this.appendSubmissionEvent(traceStore, 'artifactWaitTimedOut', traceRefs, {
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
            this.appendSubmissionEvent(traceStore, 'statusArtifactFound', traceRefs, {
              status: statusArtifact.status,
              reason: statusArtifact.reason,
              artifacts: [{ path: statusSpec.path, role: 'status' }]
            });
            return {
              status: statusArtifact.status === 'blocked' ? 'blocked' : 'failed',
              blockedReason: statusArtifact.status === 'blocked' ? statusArtifact.reason : undefined,
              error: statusArtifact.status === 'failed' ? statusArtifact.reason : undefined,
              outputArtifact: statusPath
            };
          }

          submissionDebug.completedAt = new Date().toISOString();
          submissionDebug.resultStatus = 'succeeded';
          submissionDebug.checkpoint = 'artifactFound';
          this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
          this.appendSubmissionEvent(traceStore, 'artifactFound', traceRefs, {
            artifacts: [{ path: outputSpec.path, role: 'output' }]
          });
          if (outputSpec.schema === MASTER_PLAN_SCHEMA_ID) {
            traceStore.appendTyped(TRACE_EVENTS.PLAN_CREATED, {
              artifacts: [{ path: outputSpec.path, role: 'masterPlan' }]
            });
          }
          return {
            status: 'succeeded',
            outputArtifact: outputPath,
            output: waitResult.value
          };
        },
        context.token
      );
    } catch (error) {
      submissionDebug.completedAt = new Date().toISOString();
      submissionDebug.resultStatus = 'failed';
      submissionDebug.error = error instanceof Error ? error.message : String(error);
      submissionDebug.checkpoint = 'failed';
      this.persistSubmissionDebug(context, submissionDebugArtifact, submissionDebug);
      this.appendSubmissionEvent(traceStore, 'failed', traceRefs, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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

  private buildTraceRefs(
    step: WorkflowStep,
    stepRun: WorkflowStepRun,
    title: string,
    outputPath: string,
    statusPath: string,
    submissionId: string,
    submissionDebugArtifact: string
  ): Record<string, unknown> {
    return {
      stepId: step.id,
      stepRunId: stepRun.stepRunId,
      definitionId: stepRun.definitionId,
      title,
      submissionId,
      expectedArtifact: outputPath,
      statusArtifact: statusPath,
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
    outputFormat: ArtifactSpec['format'],
    correlationMarker: string
  ): string {
    return [
      userPrompt,
      '',
      correlationMarker,
      '',
      'Workflow step output contract:',
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
    statusPath: string
  ): string {
    return [
      'Workflow agent correlation:',
      `- Submission ID: ${submissionId}`,
      `- Run ID: ${context.run.id}`,
      `- Workflow ID: ${context.run.workflowId}`,
      `- Step ID: ${step.id}`,
      `- Step Run ID: ${stepRun.stepRunId}`,
      `- Title: ${title}`,
      `- Expected output artifact: ${outputPath}`,
      `- Status artifact: ${statusPath}`,
      'Use this block to match the visible Cursor chat/Composer run back to the workflow trace.'
    ].join('\n');
  }
}
