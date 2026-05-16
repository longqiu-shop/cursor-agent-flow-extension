import test from 'node:test';
import assert from 'node:assert/strict';
import { FanoutStepExecutor } from './fanoutStepExecutor';
import type { StepStatus, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { StepExecutionResult, WorkflowExecutionContext } from './workflowRunner';
import type { ArtifactStore } from './artifactStore';
import type { WorkflowVariables } from './variableResolver';

interface ChildCall {
  stepId: string;
  stepRunId: string;
  itemNumber: number;
  index: number;
  variables: WorkflowVariables;
}

const succeededStepRun = (step: WorkflowStep, stepRunId: string): WorkflowStepRun => ({
  stepRunId,
  definitionId: step.id,
  type: step.type,
  status: 'succeeded'
});

const workflowStep = (id: string): WorkflowStep => ({
  id,
  type: 'agent',
  input: {
    title: id,
    prompt: `Run ${id}`
  },
  output: {
    path: `${id}.md`,
    format: 'markdown'
  }
});

function createContext(
  items: Array<{ number: number }>,
  executeChildStep: WorkflowExecutionContext['executeChildStep']
): WorkflowExecutionContext {
  return {
    workflow: {
      id: 'unit-workflow',
      name: 'Unit Workflow',
      filePath: '.cursor/workflows/unit.json',
      version: 1,
      steps: []
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'unit-workflow',
      workflowName: 'Unit Workflow',
      status: 'running',
      runDir: '/tmp/unit-run',
      startedAt: '2026-05-15T00:00:00.000Z',
      steps: []
    } satisfies WorkflowRun,
    artifactStore: {} as ArtifactStore,
    variables: {
      steps: {
        'read-prs': {
          output: items
        }
      }
    },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as WorkflowExecutionContext['token'],
    executeChildStep
  };
}

function createFanoutStep(input: Record<string, unknown>): WorkflowStep {
  return {
    id: 'review-prs',
    type: 'fanout',
    input
  };
}

test('fanout preserves legacy input.step behavior with exact item variables', async () => {
  const executor = new FanoutStepExecutor();
  const calls: ChildCall[] = [];
  const reviewStep = workflowStep('review-pr');
  const items = [{ number: 101 }, { number: 202 }];
  const context = createContext(items, async (step, stepRunId, variables) => {
    const item = variables.item as { number: number };
    calls.push({
      stepId: step.id,
      stepRunId,
      itemNumber: item.number,
      index: variables.index as number,
      variables: { ...variables }
    });

    return {
      stepRun: succeededStepRun(step, stepRunId),
      result: {
        status: 'succeeded',
        outputArtifact: `reviews/pr-${item.number}.md`,
        output: `reviewed ${item.number}`
      }
    };
  });

  const result = await executor.execute(
    createFanoutStep({
      itemsFrom: 'steps.read-prs.output',
      step: reviewStep
    }),
    {} as WorkflowStepRun,
    context
  );

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map(call => call.stepId), ['review-pr', 'review-pr']);
  assert.deepEqual(calls.map(call => call.stepRunId), [
    'review-prs.review-pr_101_0',
    'review-prs.review-pr_202_1'
  ]);
  assert.deepEqual(calls.map(call => [call.itemNumber, call.index]), [[101, 0], [202, 1]]);
  assert.equal(calls[0].variables.stepRunId, 'review-prs.review-pr_101_0');
  assert.equal(calls[1].variables.stepRunId, 'review-prs.review-pr_202_1');
  assert.equal(result.childRuns?.length, 2);
  assert.equal(result.childRuns?.[0].stepRunId, 'review-prs.review-pr_101_0');
  assert.equal(result.output, result.childRuns);
});

test('fanout input.steps runs each item sequentially and exposes prior child output to later child steps', async () => {
  const executor = new FanoutStepExecutor();
  const calls: ChildCall[] = [];
  const reviewStep = workflowStep('review-pr');
  const commentStep = workflowStep('comment-pr');
  const items = [{ number: 7 }, { number: 8 }];
  const context = createContext(items, async (step, stepRunId, variables) => {
    const item = variables.item as { number: number };
    calls.push({
      stepId: step.id,
      stepRunId,
      itemNumber: item.number,
      index: variables.index as number,
      variables: { ...variables }
    });

    if (step.id === 'comment-pr') {
      const steps = variables.steps as Record<string, { outputArtifact?: string; status?: StepStatus }>;
      assert.equal(steps['review-pr'].status, 'succeeded');
      assert.equal(steps['review-pr'].outputArtifact, `reviews/pr-${item.number}.md`);
    }

    const outputArtifact = step.id === 'review-pr'
      ? `reviews/pr-${item.number}.md`
      : `comments/pr-${item.number}.md`;

    return {
      stepRun: succeededStepRun(step, stepRunId),
      result: {
        status: 'succeeded',
        outputArtifact,
        output: `${step.id} ${item.number}`
      }
    };
  });

  const result = await executor.execute(
    createFanoutStep({
      itemsFrom: 'steps.read-prs.output',
      steps: [reviewStep, commentStep]
    }),
    {} as WorkflowStepRun,
    context
  );

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map(call => `${call.stepId}:${call.itemNumber}`), [
    'review-pr:7',
    'comment-pr:7',
    'review-pr:8',
    'comment-pr:8'
  ]);
  assert.deepEqual(calls.map(call => call.stepRunId), [
    'review-prs.review-pr_7_0',
    'review-prs.comment-pr_7_0',
    'review-prs.review-pr_8_1',
    'review-prs.comment-pr_8_1'
  ]);
  assert.equal(result.childRuns?.length, 4);
  assert.deepEqual(result.childRuns?.map(run => run.definitionId), [
    'review-pr',
    'comment-pr',
    'review-pr',
    'comment-pr'
  ]);
});

test('fanout input.steps stops immediately when a child step fails', async () => {
  const executor = new FanoutStepExecutor();
  const calls: ChildCall[] = [];
  const reviewStep = workflowStep('review-pr');
  const commentStep = workflowStep('comment-pr');
  const context = createContext([{ number: 11 }, { number: 12 }], async (step, stepRunId, variables) => {
    const item = variables.item as { number: number };
    calls.push({
      stepId: step.id,
      stepRunId,
      itemNumber: item.number,
      index: variables.index as number,
      variables: { ...variables }
    });

    const result: StepExecutionResult = step.id === 'comment-pr'
      ? {
          status: 'failed',
          error: 'GitHub rejected the comment'
        }
      : {
          status: 'succeeded',
          outputArtifact: `reviews/pr-${item.number}.md`
        };

    return {
      stepRun: {
        ...succeededStepRun(step, stepRunId),
        status: result.status
      },
      result
    };
  });

  const result = await executor.execute(
    createFanoutStep({
      itemsFrom: 'steps.read-prs.output',
      steps: [reviewStep, commentStep]
    }),
    {} as WorkflowStepRun,
    context
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'GitHub rejected the comment');
  assert.deepEqual(calls.map(call => `${call.stepId}:${call.itemNumber}`), [
    'review-pr:11',
    'comment-pr:11'
  ]);
  assert.equal(result.childRuns?.length, 2);
  assert.equal(result.childRuns?.[1].status, 'failed');
});
