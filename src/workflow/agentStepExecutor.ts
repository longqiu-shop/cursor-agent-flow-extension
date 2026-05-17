import * as fs from 'fs';
import * as path from 'path';
import { ArtifactSpec, StepStatusArtifact, WorkflowStep, WorkflowStepRun } from '../types';
import type { AgentCommandInvocationEvent, AgentSubmitOptions, AgentSubmitResult } from '../agent/cursorAgentRunner';
import { renderTemplate } from './variableResolver';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import type { ArtifactWaitResult } from './artifactStore';
import { STEP_STATUS_SCHEMA_ID } from './workflowSchemas';
import { TraceStore } from './traceStore';
import { sha256 } from './plannerContractResolver';

interface AgentStepInput {
  title?: string;
  prompt?: string;
  promptFile?: string;
  freshChat?: boolean;
  submitMode?: 'worktree' | 'currentWorkspace';
}

interface AgentPromptRunner {
  submitPrompt(prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult>;
}

interface AgentSubmissionQueue {
  enqueue<T>(run: () => Promise<T>, token?: WorkflowExecutionContext['token']): Promise<T>;
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

    const title = input?.title ? renderTemplate(input.title, context.variables) : step.name ?? step.id;
    const outputPath = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
    const statusSpec: ArtifactSpec = {
      path: `status/${stepRun.stepRunId}.json`,
      format: 'json',
      schema: STEP_STATUS_SCHEMA_ID
    };
    const statusPath = context.artifactStore.resolveArtifactPath(statusSpec.path, context.variables);
    stepRun.title = title;
    stepRun.promptPreview = promptTemplate.value.slice(0, 200);
    stepRun.expectedArtifact = outputPath;

    const traceStore = new TraceStore(context.run.runDir);
    const traceRefs = this.buildTraceRefs(step, stepRun, title, outputPath, statusPath);
    const renderedUserPrompt = renderTemplate(promptTemplate.value, context.variables);
    const plannerPromptRefs = this.persistPlannerPromptArtifacts(step, context, traceStore, renderedUserPrompt);
    const prompt = this.buildPrompt(renderedUserPrompt, outputPath, statusPath, step.output.format);
    this.appendSubmissionEvent(traceStore, 'queued', traceRefs, {
      freshChat: input?.freshChat !== false,
      submitMode: input?.submitMode ?? 'worktree'
    });

    let submitResult: AgentSubmitResult;
    try {
      submitResult = await this.submissionQueue.enqueue(
        () => {
          this.appendSubmissionEvent(traceStore, 'submitting', traceRefs);
          return this.runner.submitPrompt(prompt, {
            title,
            freshChat: input?.freshChat !== false,
            submitMode: input?.submitMode ?? 'worktree',
            onCommand: event => this.appendCommandEvent(traceStore, traceRefs, event)
          });
        },
        context.token
      );
    } catch (error) {
      this.appendSubmissionEvent(traceStore, 'failed', traceRefs, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    if (!submitResult.success) {
      this.appendSubmissionEvent(traceStore, 'failed', traceRefs, {
        error: submitResult.error || 'Failed to submit agent prompt'
      });
      return {
        status: 'failed',
        error: submitResult.error || 'Failed to submit agent prompt'
      };
    }

    this.appendSubmissionEvent(traceStore, 'submitted', traceRefs);
    if (plannerPromptRefs) {
      traceStore.append('planner.promptSubmitted', plannerPromptRefs);
    }
    this.appendSubmissionEvent(traceStore, 'waitingForArtifact', traceRefs, {
      artifacts: [
        { path: outputPath, role: 'output' },
        { path: statusPath, role: 'status' }
      ]
    });
    const waitResult = await this.waitForOutputOrStatus(step.output, statusSpec, context);
    if (waitResult.status === 'cancelled') {
      this.appendSubmissionEvent(traceStore, 'cancelled', traceRefs);
      return { status: 'cancelled' };
    }
    if (waitResult.status === 'timeout') {
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
      this.appendSubmissionEvent(traceStore, 'statusArtifactFound', traceRefs, {
        status: statusArtifact.status,
        reason: statusArtifact.reason,
        artifacts: [{ path: statusPath, role: 'status' }]
      });
      return {
        status: statusArtifact.status === 'blocked' ? 'blocked' : 'failed',
        blockedReason: statusArtifact.status === 'blocked' ? statusArtifact.reason : undefined,
        error: statusArtifact.status === 'failed' ? statusArtifact.reason : undefined,
        outputArtifact: statusPath
      };
    }

    this.appendSubmissionEvent(traceStore, 'artifactFound', traceRefs, {
      artifacts: [{ path: outputPath, role: 'output' }]
    });
    return {
      status: 'succeeded',
      outputArtifact: outputPath,
      output: waitResult.value
    };
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
    statusPath: string
  ): Record<string, unknown> {
    return {
      stepId: step.id,
      stepRunId: stepRun.stepRunId,
      definitionId: stepRun.definitionId,
      title,
      expectedArtifact: outputPath,
      statusArtifact: statusPath
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
      ...(event.error ? { error: event.error } : {})
    });
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

  private buildPrompt(userPrompt: string, outputPath: string, statusPath: string, outputFormat: ArtifactSpec['format']): string {
    return [
      userPrompt,
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
}
