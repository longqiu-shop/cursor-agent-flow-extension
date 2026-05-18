import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { ArtifactStore } from './artifactStore';
import type { WorkflowExecutionContext } from './workflowRunner';
import { WorkflowPreferenceProvider } from './workflowPreferenceProvider';
import { WorkflowPreferencesStepExecutor } from './workflowPreferencesStepExecutor';

function createContext(runDir: string, writes: Array<{ path: string; value: unknown }>): WorkflowExecutionContext {
  return {
    workflow: {
      id: 'preference-workflow',
      name: 'Preference Workflow',
      filePath: '.cursor/workflows/preferences.json',
      version: 1,
      steps: []
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'preference-workflow',
      workflowName: 'Preference Workflow',
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
  id: 'preferences',
  type: 'workflowPreferences',
  output: {
    path: 'preferences/workflow-preferences.json',
    format: 'json',
    schema: 'workflow-preferences@1'
  }
};

test('workflowPreferences executor writes preference artifact and trace events', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-preferences-run-'));
  const preferenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-preferences-src-'));
  fs.writeFileSync(path.join(preferenceDir, 'review.md'), 'Prefer review then verify.', 'utf-8');
  const writes: Array<{ path: string; value: unknown }> = [];
  const executor = new WorkflowPreferencesStepExecutor(new WorkflowPreferenceProvider({
    builtInDefaults: [],
    projectDirectories: [preferenceDir]
  }));
  const stepRun: WorkflowStepRun = {
    stepRunId: 'preferences',
    definitionId: 'preferences',
    type: 'workflowPreferences',
    status: 'running'
  };

  const result = await executor.execute(step, stepRun, createContext(runDir, writes));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputArtifact, path.join(runDir, 'preferences/workflow-preferences.json'));
  assert.equal(writes[0].path, 'preferences/workflow-preferences.json');
  assert.deepEqual((writes[0].value as { preferences: Array<{ id: string }> }).preferences.map(preference => preference.id), ['review']);
  const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf-8');
  assert.match(events, /workflowPreferences\.discovered/);
  assert.match(events, /workflowPreferences\.resolved/);
});

test('workflowPreferences executor rejects invalid run overrides', async () => {
  const executor = new WorkflowPreferencesStepExecutor(new WorkflowPreferenceProvider());

  const result = await executor.execute({
    ...step,
    input: {
      overrides: [{ id: '', content: '' }]
    }
  }, {} as WorkflowStepRun, createContext(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-preferences-run-')), []));

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /id must be a non-empty string/);
});
