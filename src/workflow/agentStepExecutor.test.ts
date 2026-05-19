import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentStepExecutor } from './agentStepExecutor';
import type { AgentSubmitOptions, AgentSubmitResult } from '../agent/cursorAgentRunner';
import { CursorAgentSubmissionQueue } from '../agent/cursorAgentSubmissionQueue';
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function createContext(runDir: string, waitResult: ArtifactWaitResult<unknown>): WorkflowExecutionContext {
  const artifactStore = {
    resolveArtifactPath: (artifactPath: string) => path.join(runDir, artifactPath),
    writeText: (artifactPath: string, value: string) => {
      const resolved = path.join(runDir, artifactPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, value, 'utf-8');
      return resolved;
    },
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

function createControlledWaitContext(runDir: string): {
  context: WorkflowExecutionContext;
  resolveStarted: () => void;
  resolveOutput: (value?: unknown) => void;
  resolveStatus: (status?: 'blocked' | 'failed', reason?: string) => void;
} {
  const startedWait = deferred<ArtifactWaitResult<unknown>>();
  const outputWait = deferred<ArtifactWaitResult<unknown>>();
  const statusWait = deferred<ArtifactWaitResult<unknown>>();
  const artifactStore = {
    resolveArtifactPath: (artifactPath: string) => path.join(runDir, artifactPath),
    writeText: (artifactPath: string, value: string) => {
      const resolved = path.join(runDir, artifactPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, value, 'utf-8');
      return resolved;
    },
    waitForArtifact: async <T>(spec: ArtifactSpec): Promise<ArtifactWaitResult<T>> => {
      if (spec.path.includes('.started')) {
        return startedWait.promise as Promise<ArtifactWaitResult<T>>;
      }
      if (spec.path.includes('status')) {
        return statusWait.promise as Promise<ArtifactWaitResult<T>>;
      }
      return outputWait.promise as Promise<ArtifactWaitResult<T>>;
    }
  } as unknown as ArtifactStore;

  const context: WorkflowExecutionContext = {
    workflow: {
      id: 'agent-workflow',
      name: 'Agent Workflow',
      filePath: path.join(runDir, 'workflow.json'),
      version: 1,
      defaults: {
        timeoutSeconds: 30
      },
      steps: []
    } satisfies WorkflowDefinition,
    run: {
      id: path.basename(runDir),
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

  return {
    context,
    resolveStarted: () => startedWait.resolve({
      status: 'found',
      artifactPath: path.join(runDir, 'started.json'),
      value: { status: 'started' },
      elapsedMs: 0
    }),
    resolveOutput: (value: unknown = '# Done\n') => {
      startedWait.resolve({
        status: 'found',
        artifactPath: path.join(runDir, 'started.json'),
        value: { status: 'started' },
        elapsedMs: 0
      });
      outputWait.resolve({
        status: 'found',
        artifactPath: path.join(runDir, 'output.md'),
        value,
        elapsedMs: 0
      });
    },
    resolveStatus: (status: 'blocked' | 'failed' = 'blocked', reason = 'needs input') => {
      startedWait.resolve({
        status: 'found',
        artifactPath: path.join(runDir, 'started.json'),
        value: { status: 'started' },
        elapsedMs: 0
      });
      statusWait.resolve({
        status: 'found',
        artifactPath: path.join(runDir, 'status.json'),
        value: {
          schemaVersion: '1',
          status,
          reason
        },
        elapsedMs: 0
      });
    }
  };
}

function createStartedMarkerRetryContext(
  runDir: string,
  startedStatuses: Array<'found' | 'timeout'>
): {
  context: WorkflowExecutionContext;
  startedPaths: string[];
  outputPaths: string[];
} {
  const startedPaths: string[] = [];
  const outputPaths: string[] = [];
  let startedIndex = 0;
  const artifactStore = {
    resolveArtifactPath: (artifactPath: string) => path.join(runDir, artifactPath),
    writeText: (artifactPath: string, value: string) => {
      const resolved = path.join(runDir, artifactPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, value, 'utf-8');
      return resolved;
    },
    waitForArtifact: async <T>(spec: ArtifactSpec): Promise<ArtifactWaitResult<T>> => {
      if (spec.path.includes('.started')) {
        startedPaths.push(spec.path);
        const status = startedStatuses[startedIndex] ?? 'timeout';
        startedIndex += 1;
        if (status === 'found') {
          return {
            status: 'found',
            artifactPath: path.join(runDir, spec.path),
            value: { status: 'started' } as T,
            elapsedMs: 0
          };
        }
        return {
          status: 'timeout',
          artifactPath: path.join(runDir, spec.path),
          elapsedMs: 0
        };
      }
      if (spec.path.includes('status')) {
        return new Promise<ArtifactWaitResult<T>>(() => undefined);
      }
      outputPaths.push(spec.path);
      return {
        status: 'found',
        artifactPath: path.join(runDir, spec.path),
        value: '# Done\n' as T,
        elapsedMs: 0
      };
    }
  } as unknown as ArtifactStore;

  return {
    context: {
      workflow: {
        id: 'agent-workflow',
        name: 'Agent Workflow',
        filePath: path.join(runDir, 'workflow.json'),
        version: 1,
        defaults: {
          timeoutSeconds: 30
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
    },
    startedPaths,
    outputPaths
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
    'agentSubmission.waitingForStartedMarker',
    'agentSubmission.started',
    'agentSubmission.waitingForArtifact',
    'agentSubmission.artifactFound'
  ]);
  assert.equal(events[0].refs?.checkpoint, 'queued');
  assert.equal(events[0].refs?.submitMode, 'worktree');
  assert.equal(events[2].refs?.command, 'workbench.action.chat.open');
  assert.equal(events[2].refs?.phase, 'invoking');
  assert.equal(events[2].refs?.commandTimestamp, '2026-05-16T00:00:01.000Z');
  assert.equal(events[6].refs?.checkpoint, 'submitted');
  assert.equal(events[7].refs?.checkpoint, 'waitingForStartedMarker');
  assert.equal(events[8].refs?.checkpoint, 'started');
  assert.equal(events[9].refs?.checkpoint, 'waitingForArtifact');
  assert.deepEqual(events.map(event => event.id), [
    'event-1',
    'event-2',
    'event-3',
    'event-4',
    'event-5',
    'event-6',
    'event-7',
    'event-8',
    'event-9',
    'event-10',
    'event-11'
  ]);
});

test('agent submission queue holds later prompts until earlier agent artifacts resolve', async () => {
  const firstRunDir = tempRunDir();
  const secondRunDir = tempRunDir();
  const firstWait = createControlledWaitContext(firstRunDir);
  const secondWait = createControlledWaitContext(secondRunDir);
  const submissions: string[] = [];
  const runner = {
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submissions.push(options?.title ?? '<untitled>');
      return {
        success: true,
        output: 'submitted'
      };
    }
  };
  const executor = new AgentStepExecutor(runner, new CursorAgentSubmissionQueue());
  const firstStep: WorkflowStep = {
    ...step,
    id: 'first-agent',
    input: {
      title: 'first agent',
      prompt: 'Run first agent task.'
    },
    output: {
      path: 'first-output.md',
      format: 'markdown'
    }
  };
  const secondStep: WorkflowStep = {
    ...step,
    id: 'second-agent',
    input: {
      title: 'second agent',
      prompt: 'Run second agent task.'
    },
    output: {
      path: 'second-output.md',
      format: 'markdown'
    }
  };

  const firstResult = executor.execute(firstStep, {
    stepRunId: 'first-agent',
    definitionId: 'first-agent',
    type: 'agent',
    status: 'running'
  }, firstWait.context);
  await waitUntil(() => submissions.length === 1);

  const secondResult = executor.execute(secondStep, {
    stepRunId: 'second-agent',
    definitionId: 'second-agent',
    type: 'agent',
    status: 'running'
  }, secondWait.context);
  await settleMicrotasks();

  assert.deepEqual(submissions, ['first agent']);

  firstWait.resolveOutput();
  assert.equal((await firstResult).status, 'succeeded');
  await waitUntil(() => submissions.length === 2);
  assert.deepEqual(submissions, ['first agent', 'second agent']);

  secondWait.resolveOutput();
  assert.equal((await secondResult).status, 'succeeded');
});

test('agent submission queue releases later workflow prompt after earlier agent status artifact resolves', async () => {
  const firstRunDir = tempRunDir();
  const secondRunDir = tempRunDir();
  const firstWait = createControlledWaitContext(firstRunDir);
  const secondWait = createControlledWaitContext(secondRunDir);
  const submissions: string[] = [];
  const executor = new AgentStepExecutor({
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submissions.push(options?.title ?? '<untitled>');
      return {
        success: true,
        output: 'submitted'
      };
    }
  }, new CursorAgentSubmissionQueue());

  const firstResult = executor.execute({
    ...step,
    id: 'workflow-a-agent',
    input: {
      title: 'workflow A current agent',
      prompt: 'Run workflow A current task.'
    },
    output: {
      path: 'workflow-a-output.md',
      format: 'markdown'
    }
  }, {
    stepRunId: 'workflow-a.current',
    definitionId: 'workflow-a-agent',
    type: 'agent',
    status: 'running'
  }, firstWait.context);
  await waitUntil(() => submissions.length === 1);

  const secondResult = executor.execute({
    ...step,
    id: 'workflow-b-agent',
    input: {
      title: 'workflow B agent',
      prompt: 'Run workflow B task.'
    },
    output: {
      path: 'workflow-b-output.md',
      format: 'markdown'
    }
  }, {
    stepRunId: 'workflow-b.current',
    definitionId: 'workflow-b-agent',
    type: 'agent',
    status: 'running'
  }, secondWait.context);
  await settleMicrotasks();

  assert.deepEqual(submissions, ['workflow A current agent']);

  firstWait.resolveStatus('blocked', 'waiting for human input');
  const firstStepResult = await firstResult;
  assert.equal(firstStepResult.status, 'blocked');
  assert.equal(firstStepResult.blockedReason, 'waiting for human input');
  await waitUntil(() => submissions.length === 2);
  assert.deepEqual(submissions, ['workflow A current agent', 'workflow B agent']);

  secondWait.resolveOutput();
  assert.equal((await secondResult).status, 'succeeded');
});

test('agent submission queue serializes current agent task only, not an entire workflow run', async () => {
  const workflowARunDir = tempRunDir();
  const workflowBRunDir = tempRunDir();
  const firstAWait = createControlledWaitContext(workflowARunDir);
  const workflowBWait = createControlledWaitContext(workflowBRunDir);
  const secondAWait = createControlledWaitContext(workflowARunDir);
  const submissions: string[] = [];
  const executor = new AgentStepExecutor({
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submissions.push(options?.title ?? '<untitled>');
      return {
        success: true,
        output: 'submitted'
      };
    }
  }, new CursorAgentSubmissionQueue());

  const runAgentStep = (
    title: string,
    context: WorkflowExecutionContext,
    stepRunId: string
  ): Promise<ReturnType<AgentStepExecutor['execute']> extends Promise<infer T> ? T : never> => executor.execute({
    ...step,
    id: stepRunId,
    input: {
      title,
      prompt: `Run ${title}.`
    },
    output: {
      path: `${stepRunId}.md`,
      format: 'markdown'
    }
  }, {
    stepRunId,
    definitionId: stepRunId,
    type: 'agent',
    status: 'running'
  }, context);

  const workflowAFirst = runAgentStep('workflow A first agent', firstAWait.context, 'workflow-a-first');
  await waitUntil(() => submissions.length === 1);

  const workflowB = runAgentStep('workflow B agent', workflowBWait.context, 'workflow-b');
  await settleMicrotasks();
  assert.deepEqual(submissions, ['workflow A first agent']);

  firstAWait.resolveOutput();
  assert.equal((await workflowAFirst).status, 'succeeded');
  await waitUntil(() => submissions.length === 2);
  assert.deepEqual(submissions, ['workflow A first agent', 'workflow B agent']);

  const workflowASecond = runAgentStep('workflow A second agent', secondAWait.context, 'workflow-a-second');
  await settleMicrotasks();
  assert.deepEqual(submissions, ['workflow A first agent', 'workflow B agent']);

  workflowBWait.resolveOutput();
  assert.equal((await workflowB).status, 'succeeded');
  await waitUntil(() => submissions.length === 3);
  assert.deepEqual(submissions, ['workflow A first agent', 'workflow B agent', 'workflow A second agent']);

  secondAWait.resolveOutput();
  assert.equal((await workflowASecond).status, 'succeeded');
});

test('agent step persists exact final submitted prompt when requested', async () => {
  const runDir = tempRunDir();
  let submittedPrompt = '';
  let submittedOptions: AgentSubmitOptions | undefined;
  const runner = {
    submitPrompt: async (prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submittedPrompt = prompt;
      submittedOptions = options;
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
  const taskStep: WorkflowStep = {
    ...step,
    id: 'plan-execute-complete-goal',
    input: {
      title: 'execute: complete-goal',
      prompt: 'Complete the goal.',
      promptArtifact: 'tasks/execute/complete-goal/prompt.md',
      stageId: 'execute',
      taskId: 'complete-goal'
    },
    output: {
      path: 'tasks/execute/complete-goal/output.md',
      format: 'markdown'
    }
  };

  const result = await executor.execute(taskStep, {
    stepRunId: 'planRuntime.execute.complete-goal',
    definitionId: taskStep.id,
    type: 'agent',
    status: 'running'
  }, createContext(runDir, {
    status: 'found',
    artifactPath: path.join(runDir, 'tasks/execute/complete-goal/output.md'),
    value: '# Done\n',
    elapsedMs: 0
  }));

  const persistedPrompt = fs.readFileSync(path.join(runDir, 'tasks/execute/complete-goal/prompt.md'), 'utf-8');
  const submissionDebug = JSON.parse(
    fs.readFileSync(path.join(runDir, 'tasks/execute/complete-goal/submission-debug.json'), 'utf-8')
  ) as {
    submissionId: string;
    checkpoint: string;
    promptSha256: string;
    promptArtifact: string;
    expectedArtifact: string;
    statusArtifact: string;
    correlationMarker: string;
    resultStatus: string;
  };
  const events = readEvents(runDir);
  assert.equal(result.status, 'succeeded');
  assert.equal(persistedPrompt, submittedPrompt);
  assert.equal(submittedOptions?.correlationId, submissionDebug.submissionId);
  assert.match(persistedPrompt, /Complete the goal\./);
  assert.match(persistedPrompt, /Workflow agent correlation:/);
  assert.match(persistedPrompt, new RegExp(`Submission ID: ${submissionDebug.submissionId}`));
  assert.match(persistedPrompt, /Workflow step output contract:/);
  assert.equal(submissionDebug.checkpoint, 'artifactFound');
  assert.equal(submissionDebug.promptArtifact, 'tasks/execute/complete-goal/prompt.md');
  assert.equal(submissionDebug.expectedArtifact, 'tasks/execute/complete-goal/output.md');
  assert.equal(submissionDebug.statusArtifact, 'status/planRuntime.execute.complete-goal.json');
  assert.equal(submissionDebug.resultStatus, 'succeeded');
  assert.match(submissionDebug.correlationMarker, /Step Run ID: planRuntime\.execute\.complete-goal/);
  assert.equal(events.some(event => event.type === 'agent.prompted'), true);
  assert.equal(events.some(event => event.refs?.submissionId === submissionDebug.submissionId), true);
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
    'agentSubmission.submitFailed',
    'agentSubmission.retrying',
    'agentSubmission.submitting',
    'agentSubmission.submitFailed',
    'agentSubmission.failed'
  ]);
  assert.equal(events[6].refs?.error, 'composer command unavailable');
});

test('agent step retries with attempt-scoped artifacts when started marker is missing', async () => {
  const runDir = tempRunDir();
  const context = createStartedMarkerRetryContext(runDir, ['timeout', 'found']);
  const submissions: AgentSubmitOptions[] = [];
  const runner = {
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submissions.push(options ?? {});
      return {
        success: true,
        output: 'submitted'
      };
    }
  };
  const executor = new AgentStepExecutor(runner, {
    enqueue: async <T>(run: () => Promise<T>): Promise<T> => run()
  });

  const result = await executor.execute(step, {
    stepRunId: 'planner',
    definitionId: 'planner',
    type: 'agent',
    status: 'running'
  }, context.context);

  const events = readEvents(runDir);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputArtifact, path.join(runDir, 'plan/master-plan.attempt-2.json'));
  assert.deepEqual(submissions.map(options => options.attempt), [1, 2]);
  assert.deepEqual(context.startedPaths, [
    'plan/master-plan.started.json',
    'plan/master-plan.started.attempt-2.json'
  ]);
  assert.deepEqual(context.outputPaths, ['plan/master-plan.attempt-2.json']);
  assert.equal(events.some(event => event.type === 'agentSubmission.startedMarkerMissing'), true);
  assert.equal(events.some(event => event.type === 'agentSubmission.retrying'), true);
  assert.equal(events.some(event => event.type === 'agentSubmission.started' && event.refs?.attempt === 2), true);
});

test('agent step fails notStarted and releases queue when retry marker is missing', async () => {
  const runDir = tempRunDir();
  const context = createStartedMarkerRetryContext(runDir, ['timeout', 'timeout']);
  const submissions: AgentSubmitOptions[] = [];
  const runner = {
    submitPrompt: async (_prompt: string, options?: AgentSubmitOptions): Promise<AgentSubmitResult> => {
      submissions.push(options ?? {});
      return {
        success: true,
        output: 'submitted'
      };
    }
  };
  const executor = new AgentStepExecutor(runner, {
    enqueue: async <T>(run: () => Promise<T>): Promise<T> => run()
  });

  const result = await executor.execute(step, {
    stepRunId: 'planner',
    definitionId: 'planner',
    type: 'agent',
    status: 'running'
  }, context.context);

  const debug = JSON.parse(fs.readFileSync(path.join(runDir, 'plan/submission-debug.json'), 'utf-8')) as {
    failureCategory?: string;
    attempts?: Array<{ markerStatus?: string }>;
  };
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /started marker/);
  assert.deepEqual(submissions.map(options => options.attempt), [1, 2]);
  assert.deepEqual(context.outputPaths, []);
  assert.equal(debug.failureCategory, 'notStarted');
  assert.deepEqual(debug.attempts?.map(attempt => attempt.markerStatus), ['timeout', 'timeout']);
});

test('planner step persists rendered prompt metadata and trace events', async () => {
  const runDir = tempRunDir();
  let submittedPrompt = '';
  const runner = {
    submitPrompt: async (prompt: string): Promise<AgentSubmitResult> => {
      submittedPrompt = prompt;
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
  const context = createContext(runDir, {
    status: 'found',
    artifactPath: path.join(runDir, 'plan/master-plan.json'),
    value: { schemaVersion: '1' },
    elapsedMs: 0
  });
  context.workflow.plannerContract = {
    contractId: 'agentic-workflow-planner',
    contractVersion: '1',
    source: 'extension-default',
    workflowPath: '/extension/out/assets/workflows/agentic-workflow-bootstrap.json',
    promptPath: '/extension/out/assets/prompts/agentic-workflow-planner.md',
    sha256: 'template-sha',
    resolvedAt: '2026-05-16T00:00:00.000Z',
    extensionVersion: '1.0.1'
  };
  context.variables = {
    trigger: {
      goal: 'Summarize changes'
    }
  };
  const plannerStep: WorkflowStep = {
    ...step,
    input: {
      ...step.input,
      prompt: 'Goal: {{ trigger.goal }}'
    }
  };

  const result = await executor.execute(plannerStep, {
    stepRunId: 'planner',
    definitionId: 'planner',
    type: 'agent',
    status: 'running'
  }, context);

  const events = readEvents(runDir);
  const prompt = fs.readFileSync(path.join(runDir, 'planner', 'prompt.md'), 'utf-8');
  const metadata = JSON.parse(fs.readFileSync(path.join(runDir, 'planner', 'prompt-metadata.json'), 'utf-8')) as {
    renderedPromptSha256?: string;
    source?: string;
  };
  assert.equal(result.status, 'succeeded');
  assert.equal(prompt, 'Goal: Summarize changes');
  assert.match(submittedPrompt, /^Goal: Summarize changes/);
  assert.match(submittedPrompt, /Workflow step output contract:/);
  assert.equal(metadata.source, 'extension-default');
  assert.equal(metadata.renderedPromptSha256, events.find(event => event.type === 'planner.promptRendered')?.refs?.renderedPromptSha256);
  assert.deepEqual(events.map(event => event.type).filter(type => type.startsWith('planner.')), [
    'planner.contractResolved',
    'planner.promptRendered',
    'planner.promptSubmitted'
  ]);
});
