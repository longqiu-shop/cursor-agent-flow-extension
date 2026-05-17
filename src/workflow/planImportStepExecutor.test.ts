import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlanImportStepExecutor } from './planImportStepExecutor';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import type { MasterPlan } from './planSchemas';
import type { WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowStepRun } from '../types';
import type { WorkflowExecutionContext } from './workflowRunner';
import type { ArtifactStore } from './artifactStore';

function tempDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validPlan(): MasterPlan {
  return {
    schemaVersion: '1',
    objective: 'Summarize changes',
    riskLevel: 'low',
    allowedCapabilities: ['read', 'workspaceWrite'],
    stages: [
      {
        id: 'execute',
        tasks: [
          {
            id: 'summarize',
            type: 'agent',
            goal: 'Summarize changes',
            successCriteria: ['Summary exists'],
            evidenceRequired: ['tasks/execute/summarize/output.md'],
            confidencePolicy: {
              requireAllCriteria: true,
              requireAllEvidence: true,
              onFailure: 'block'
            },
            expectedOutputs: [
              {
                path: 'tasks/execute/summarize/output.md',
                format: 'markdown',
                required: true
              }
            ],
            tools: ['workflow.agent']
          }
        ]
      }
    ]
  };
}

const step: WorkflowStep = {
  id: 'import-plan',
  type: 'planImport',
  input: {
    planPath: '{{ trigger.planPath }}'
  },
  output: {
    path: 'plan/master-plan.json',
    format: 'json',
    schema: 'master-plan@1'
  }
};

const stepRun: WorkflowStepRun = {
  stepRunId: 'import-plan',
  definitionId: 'import-plan',
  type: 'planImport',
  status: 'running'
};

function createContext(runDir: string, planPath: string): WorkflowExecutionContext {
  return {
    workflow: {
      id: 'ready-plan',
      name: 'Ready Plan',
      filePath: '.cursor/workflows/ready-plan.json',
      version: 1,
      steps: [step]
    } satisfies WorkflowDefinition,
    run: {
      id: 'run-unit',
      workflowId: 'ready-plan',
      workflowName: 'Ready Plan',
      status: 'running',
      runDir,
      startedAt: '2026-05-16T00:00:00.000Z',
      steps: []
    } satisfies WorkflowRun,
    artifactStore: createArtifactStore(runDir),
    variables: {
      trigger: {
        planPath
      }
    },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    } as WorkflowExecutionContext['token'],
    executeChildStep: async () => {
      throw new Error('not used');
    }
  };
}

function createArtifactStore(runDir: string): ArtifactStore {
  return {
    writeJson: (artifactPath: string, value: unknown) => {
      const resolved = path.resolve(runDir, artifactPath);
      const relative = path.relative(runDir, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes runDir: ${artifactPath}`);
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
      return resolved;
    }
  } as ArtifactStore;
}

test('imports strict JSON master plans', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(trustedDir, 'plan.json');
  fs.writeFileSync(planPath, `${JSON.stringify(validPlan(), null, 2)}\n`, 'utf-8');
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, planPath));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputArtifact, path.join(runDir, 'plan/master-plan.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'plan/master-plan.json'), 'utf-8')), validPlan());
  const importValidation = JSON.parse(fs.readFileSync(path.join(runDir, 'plan/import-validation.json'), 'utf-8')) as { valid: boolean };
  assert.equal(importValidation.valid, true);
  assert.equal(fs.readFileSync(planPath, 'utf-8'), `${JSON.stringify(validPlan(), null, 2)}\n`);
});

test('imports markdown with one executable master-plan block', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(trustedDir, 'plan.md');
  fs.writeFileSync(planPath, [
    '# Ready plan',
    '',
    '```json master-plan@1',
    JSON.stringify(validPlan(), null, 2),
    '```',
    ''
  ].join('\n'), 'utf-8');
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, planPath));

  assert.equal(result.status, 'succeeded');
  const importValidation = JSON.parse(fs.readFileSync(path.join(runDir, 'plan/import-validation.json'), 'utf-8')) as { format: string };
  assert.equal(importValidation.format, 'markdown');
});

test('imports plans from advertised tilde-prefixed paths', async t => {
  const fakeHome = fs.mkdtempSync(path.join(process.cwd(), '.tmp-plan-import-home-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
  const trustedDir = path.join(fakeHome, 'plans');
  fs.mkdirSync(trustedDir, { recursive: true });
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(trustedDir, 'plan.json');
  fs.writeFileSync(planPath, `${JSON.stringify(validPlan(), null, 2)}\n`, 'utf-8');
  const tildePlanPath = `~/${path.relative(fakeHome, planPath).split(path.sep).join('/')}`;
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir], fakeHome);

  const result = await executor.execute(step, stepRun, createContext(runDir, tildePlanPath));

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'plan/master-plan.json'), 'utf-8')), validPlan());
  const importValidation = JSON.parse(fs.readFileSync(path.join(runDir, 'plan/import-validation.json'), 'utf-8')) as { sourcePath: string };
  assert.equal(importValidation.sourcePath, tildePlanPath);
});

test('blocks markdown without an executable master-plan block', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(trustedDir, 'plan.md');
  fs.writeFileSync(planPath, '```json\n{}\n```\n', 'utf-8');
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, planPath));

  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /exactly one/);
});

test('blocks markdown with multiple executable master-plan blocks', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(trustedDir, 'plan.md');
  fs.writeFileSync(planPath, [
    '```json master-plan@1',
    JSON.stringify(validPlan()),
    '```',
    '```json master-plan@1',
    JSON.stringify(validPlan()),
    '```',
    ''
  ].join('\n'), 'utf-8');
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, planPath));

  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /multiple executable/);
});

test('blocks plan paths outside trusted directories', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const outsideDir = tempDir(t, 'plan-import-outside-');
  const runDir = tempDir(t, 'plan-import-run-');
  const planPath = path.join(outsideDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(validPlan()), 'utf-8');
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, planPath));

  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /trusted directory/);
});

test('blocks symlinks that resolve outside trusted directories', async t => {
  const trustedDir = tempDir(t, 'plan-import-trusted-');
  const outsideDir = tempDir(t, 'plan-import-outside-');
  const runDir = tempDir(t, 'plan-import-run-');
  const outsidePlan = path.join(outsideDir, 'plan.json');
  const linkedPlan = path.join(trustedDir, 'linked-plan.json');
  fs.writeFileSync(outsidePlan, JSON.stringify(validPlan()), 'utf-8');
  fs.symlinkSync(outsidePlan, linkedPlan);
  const executor = new PlanImportStepExecutor(createWorkflowSchemaRegistry(), [trustedDir]);

  const result = await executor.execute(step, stepRun, createContext(runDir, linkedPlan));

  assert.equal(result.status, 'blocked');
  assert.match(result.blockedReason ?? '', /trusted directory/);
});
