import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentStepExecutor } from './agentStepExecutor';
import type { AgentSubmitOptions, AgentSubmitResult } from '../agent/cursorAgentRunner';
import type { ArtifactSpec, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { ArtifactStore, ArtifactWaitResult } from './artifactStore';
import type { WorkflowExecutionContext } from './workflowRunner';
import type { TraceEvent } from './planSchemas';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-agent-step-'));
}

function readEvents(runDir: string): TraceEvent[] {
  return fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf-8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as TraceEvent);
}

function createContext(runDir: string, waitResult: ArtifactWaitResult<unknown>): WorkflowExecutionContext {
  const artifactStore = {
    resolveArtifactPath: (artifactPath: string) => path.join(runDir, artifactPath),
    waitForArtifact: async <T>(spec: ArtifactSpec): Promise<ArtifactWaitResult<T>> => {
      if (spec.path.startsWith('status/')) {
        return new Promise<ArtifactWaitResult<T>>(() => undefined);
      }
      return {
        ...waitResult,
        artifactPath: path.join(runDir, spec.path)
      } as ArtifactWaitResult<T>;
    }
  } as unknown as ArtifactStore;

  return {
    workflow: {
      id: 'agent-workflow',
      name: 'Agent Workflow',
      filePath: path.join(runDir, 'workflow.json'),
      version: 1,
      defaults: {
        timeoutSeconds: 1
      },
      steps: []
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'agent-workflow',
      workflowName: 'Agent Workflow',
      status: 'running',
      runDir,
      startedAt: '2026-05-16T00:00:00.000Z',
      steps: []
    } satisfies WorkflowRun,
    artifactStore,
    variables: {},
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as WorkflowExecutionContext['token'],
    executeChildStep: async () => {
      throw new Error('not used');
    }
  };
}

const step: WorkflowStep = {
  id: 'planner',
  type: 'agent',
  input: {
    title: 'Plan Agentic Workflow',
    prompt: 'Write a plan.',
    freshChat: true,
    submitMode: 'worktree'
  },
  output: {
    path: 'plan/master-plan.json',
    format: 'json',
    schema: 'none'
  }
};

test('agent step persists submission lifecycle checkpoints and command telemetry', async () => {
  const runDir = tempRunDir();
  const runner = {
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      options?.onCommand?.({
        command: 'workbench.action.chat.open',
        phase: 'invoking',
        timestamp: '2026-05-16T00:00:01.000Z'
      });
      options?.onCommand?.({
        command: 'workbench.action.chat.open',
        phase: 'succeeded',
        timestamp: '2026-05-16T00:00:02.000Z'
      });
      options?.onCommand?.({
        command: 'composer.triggerCreateWorktreeButton',
        phase: 'invoking',
        timestamp: '2026-05-16T00:00:03.000Z'
      });
      options?.onCommand?.({
        command: 'composer.triggerCreateWorktreeButton',
        phase: 'succeeded',
        timestamp: '2026-05-16T00:00:04.000Z'
      });
      return {
        success: true,
        output: 'submitted'
      };
    }
  };
  const queue = {
    enqueue: async <T>(run: () => Promise<T>): Promise<T> => run()
  };
  const executor = new AgentStepExecutor(runner, queue);
  const stepRun: WorkflowStepRun = {
    stepRunId: 'planner',
    definitionId: 'planner',
    type: 'agent',
    status: 'running'
  };

  const result = await executor.execute(step, stepRun, createContext(runDir, {
    status: 'found',
    artifactPath: path.join(runDir, 'plan/master-plan.json'),
    value: { schemaVersion: '1' },
    elapsedMs: 0
  }));

  const events = readEvents(runDir);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events.map(event => event.type), [
    'agentSubmission.queued',
    'agentSubmission.submitting',
    'agentSubmission.command',
    'agentSubmission.command',
    'agentSubmission.command',
    'agentSubmission.command',
    'agentSubmission.submitted',
    'agentSubmission.waitingForArtifact',
    'agentSubmission.artifactFound'
  ]);
  assert.equal(events[0].refs?.checkpoint, 'queued');
  assert.equal(events[0].refs?.submitMode, 'worktree');
  assert.equal(events[2].refs?.command, 'workbench.action.chat.open');
  assert.equal(events[2].refs?.phase, 'invoking');
  assert.equal(events[2].refs?.commandTimestamp, '2026-05-16T00:00:01.000Z');
  assert.equal(events[6].refs?.checkpoint, 'submitted');
  assert.equal(events[7].refs?.checkpoint, 'waitingForArtifact');
  assert.deepEqual(events.map(event => event.id), [
    'event-1',
    'event-2',
    'event-3',
    'event-4',
    'event-5',
    'event-6',
    'event-7',
    'event-8',
    'event-9'
  ]);
});

test('agent step records failed submission before returning failure', async () => {
  const runDir = tempRunDir();
  const runner = {
    submitPrompt: async (): Promise<AgentSubmitResult> => ({
      success: false,
      output: '',
      error: 'composer command unavailable'
    })
  };
  const queue = {
    enqueue: async <T>(run: () => Promise<T>): Promise<T> => run()
  };
  const executor = new AgentStepExecutor(runner, queue);

  const result = await executor.execute(step, {
    stepRunId: 'planner',
    definitionId: 'planner',
    type: 'agent',
    status: 'running'
  }, createContext(runDir, {
    status: 'found',
    artifactPath: path.join(runDir, 'plan/master-plan.json'),
    elapsedMs: 0
  }));

  const events = readEvents(runDir);
  assert.equal(result.status, 'failed');
  assert.deepEqual(events.map(event => event.type), [
    'agentSubmission.queued',
    'agentSubmission.submitting',
    'agentSubmission.failed'
  ]);
  assert.equal(events[2].refs?.error, 'composer command unavailable');
});
