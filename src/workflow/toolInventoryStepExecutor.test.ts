import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { ArtifactStore } from './artifactStore';
import { ToolContextProvider } from './toolContextProvider';
import { ToolInventoryStepExecutor } from './toolInventoryStepExecutor';
import type { WorkflowExecutionContext } from './workflowRunner';

function createContext(writes: Array<{ path: string; value: unknown }>): WorkflowExecutionContext {
  const runDir = '/tmp/tool-inventory-run';
  return {
    workflow: {
      id: 'inventory-workflow',
      name: 'Inventory Workflow',
      filePath: '.cursor/workflows/inventory.json',
      version: 1,
      steps: []
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'inventory-workflow',
      workflowName: 'Inventory Workflow',
      status: 'running',
      runDir,
      startedAt: '2026-05-16T00:00:00.000Z',
      steps: []
    } satisfies WorkflowRun,
    artifactStore: {
      resolveArtifactPath: (artifactPath: string) => path.join(runDir, artifactPath),
      writeJson: (artifactPath: string, value: unknown) => {
        writes.push({ path: artifactPath, value });
        return path.join(runDir, artifactPath);
      }
    } as ArtifactStore,
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
  id: 'inventory',
  type: 'toolInventory',
  input: {
    include: ['workflowPrimitives']
  },
  output: {
    path: 'tool-inventory.json',
    format: 'json',
    schema: 'tool-inventory@1'
  }
};

test('toolInventory executor snapshots and writes inventory artifact', async () => {
  const writes: Array<{ path: string; value: unknown }> = [];
  const executor = new ToolInventoryStepExecutor(new ToolContextProvider({}));
  const stepRun: WorkflowStepRun = {
    stepRunId: 'inventory',
    definitionId: 'inventory',
    type: 'toolInventory',
    status: 'running'
  };

  const result = await executor.execute(step, stepRun, createContext(writes));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputArtifact, '/tmp/tool-inventory-run/tool-inventory.json');
  assert.equal(stepRun.expectedArtifact, '/tmp/tool-inventory-run/tool-inventory.json');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, 'tool-inventory.json');
  assert.equal((writes[0].value as { tools: unknown[] }).tools.length > 0, true);
});

test('toolInventory executor rejects unsupported include source', async () => {
  const executor = new ToolInventoryStepExecutor(new ToolContextProvider({}));
  const result = await executor.execute({
    ...step,
    input: {
      include: ['mcpTools']
    }
  }, {} as WorkflowStepRun, createContext([]));

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /unsupported source/);
});
