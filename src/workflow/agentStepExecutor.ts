import * as vscode from 'vscode';
import { ArtifactSpec, StepStatusArtifact, WorkflowStep, WorkflowStepRun } from '../types';
import { CursorAgentRunner } from '../agent/cursorAgentRunner';
import { CursorAgentSubmissionQueue } from '../agent/cursorAgentSubmissionQueue';
import { renderTemplate } from './variableResolver';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import { ArtifactWaitResult } from './artifactStore';
import { STEP_STATUS_SCHEMA_ID } from './workflowSchemas';

interface AgentStepInput {
  title?: string;
  prompt?: string;
  freshChat?: boolean;
  submitMode?: 'worktree' | 'currentWorkspace';
}

export class AgentStepExecutor implements WorkflowStepExecutor {
  readonly type = 'agent' as const;

  constructor(
    private readonly runner: CursorAgentRunner,
    private readonly submissionQueue: CursorAgentSubmissionQueue
  ) {}

  async execute(step: WorkflowStep, stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const input = step.input as AgentStepInput | undefined;
    if (!input?.prompt) {
      return {
        status: 'failed',
        error: `agent step ${step.id} requires input.prompt`
      };
    }
    if (!step.output) {
      return {
        status: 'failed',
        error: `agent step ${step.id} requires an output artifact`
      };
    }

    const title = input.title ? renderTemplate(input.title, context.variables) : step.name ?? step.id;
    const outputPath = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
    const statusSpec: ArtifactSpec = {
      path: `status/${stepRun.stepRunId}.json`,
      format: 'json',
      schema: STEP_STATUS_SCHEMA_ID
    };
    const statusPath = context.artifactStore.resolveArtifactPath(statusSpec.path, context.variables);
    stepRun.title = title;
    stepRun.promptPreview = input.prompt.slice(0, 200);
    stepRun.expectedArtifact = outputPath;

    const prompt = this.buildPrompt(renderTemplate(input.prompt, context.variables), outputPath, statusPath, step.output.format);
    const submitResult = await this.submissionQueue.enqueue(
      () => this.runner.submitPrompt(prompt, {
        title,
        freshChat: input.freshChat !== false,
        submitMode: input.submitMode ?? 'worktree'
      }),
      context.token
    );

    if (!submitResult.success) {
      return {
        status: 'failed',
        error: submitResult.error || 'Failed to submit agent prompt'
      };
    }

    const waitResult = await this.waitForOutputOrStatus(step.output, statusSpec, context);
    if (waitResult.status === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (waitResult.status === 'timeout') {
      return {
        status: 'timedOut',
        error: waitResult.error
      };
    }
    if (waitResult.statusArtifact) {
      const statusArtifact = waitResult.value as StepStatusArtifact;
      return {
        status: statusArtifact.status === 'blocked' ? 'blocked' : 'failed',
        blockedReason: statusArtifact.status === 'blocked' ? statusArtifact.reason : undefined,
        error: statusArtifact.status === 'failed' ? statusArtifact.reason : undefined,
        outputArtifact: statusPath
      };
    }

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

    const waitTokenSource = new vscode.CancellationTokenSource();
    const parentCancellation = context.token.onCancellationRequested(() => waitTokenSource.cancel());

    try {
      const waitResult = await Promise.race([
        context.artifactStore.waitForArtifact(outputSpec, context.variables, { timeoutMs, token: waitTokenSource.token })
          .then(result => ({ kind: 'output' as const, result })),
        context.artifactStore.waitForArtifact<StepStatusArtifact>(statusSpec, context.variables, { timeoutMs, token: waitTokenSource.token })
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
