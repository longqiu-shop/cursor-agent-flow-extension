import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPlanRunModel } from './planRunModel';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-plan-run-model-'));
}

test('builds a read-only model for a successful plan run', () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, 'plan-run.json'), JSON.stringify({
    schemaVersion: '1',
    status: 'succeeded',
    startedAt: '2026-05-16T00:00:00.000Z',
    tasks: [{ taskRunId: 'execute.complete-goal', stageId: 'execute', taskId: 'complete-goal', status: 'succeeded' }]
  }), 'utf-8');
  fs.mkdirSync(path.join(runDir, 'tasks/execute/complete-goal'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tasks/execute/complete-goal/validation.json'), JSON.stringify({
    schemaVersion: '1',
    valid: true,
    checkedArtifacts: ['tasks/execute/complete-goal/output.md'],
    errors: [],
    missingEvidence: [],
    risks: []
  }), 'utf-8');
  fs.writeFileSync(path.join(runDir, 'tasks/execute/complete-goal/provenance.json'), JSON.stringify({
    schemaVersion: '1',
    stageId: 'execute',
    taskId: 'complete-goal',
    selectedTools: ['workflow.agent'],
    outputHashes: []
  }), 'utf-8');
  fs.mkdirSync(path.join(runDir, 'audits/execute/complete-goal'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'audits/execute/complete-goal/audit.json'), JSON.stringify({
    schemaVersion: '1',
    criteriaResults: [],
    missingEvidence: [],
    risks: [],
    nextAction: 'advance'
  }), 'utf-8');

  const model = buildPlanRunModel(runDir);

  assert.equal(model.available, true);
  assert.equal(model.status, 'succeeded');
  assert.equal(model.tasks[0].selectedTools[0], 'workflow.agent');
  assert.equal(model.tasks[0].validationStatus, 'passed');
  assert.equal(model.tasks[0].auditNextAction, 'advance');
  assert.equal(model.tasks[0].artifacts.some(artifact => artifact.label === 'validation' && artifact.exists), true);
});

test('derives interrupted resume-unsupported state without mutating artifacts', () => {
  const runDir = tempRunDir();
  const planRunPath = path.join(runDir, 'plan-run.json');
  fs.writeFileSync(planRunPath, JSON.stringify({
    schemaVersion: '1',
    status: 'running',
    startedAt: '2026-05-16T00:00:00.000Z',
    currentStageId: 'execute',
    currentTaskId: 'complete-goal',
    tasks: [{ taskRunId: 'execute.complete-goal', stageId: 'execute', taskId: 'complete-goal', status: 'running' }]
  }), 'utf-8');
  const before = fs.readFileSync(planRunPath, 'utf-8');

  const model = buildPlanRunModel(runDir, {
    runId: 'run-1',
    activeRunIds: new Set()
  });

  assert.equal(model.status, 'interruptedResumeUnsupported');
  assert.equal(model.interruptedResumeUnsupported, true);
  assert.equal(fs.readFileSync(planRunPath, 'utf-8'), before);
  assert.equal(fs.existsSync(path.join(runDir, 'events.jsonl')), false);
});

test('handles missing plan-run and malformed task artifacts gracefully', () => {
  const runDir = tempRunDir();

  assert.equal(buildPlanRunModel(runDir).available, false);

  fs.writeFileSync(path.join(runDir, 'plan-run.json'), JSON.stringify({
    schemaVersion: '1',
    status: 'blocked',
    startedAt: '2026-05-16T00:00:00.000Z',
    tasks: [{ taskRunId: 'execute.complete-goal', stageId: 'execute', taskId: 'complete-goal', status: 'blocked' }]
  }), 'utf-8');
  fs.mkdirSync(path.join(runDir, 'tasks/execute/complete-goal'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tasks/execute/complete-goal/validation.json'), '{not json', 'utf-8');

  const model = buildPlanRunModel(runDir);

  assert.equal(model.available, true);
  assert.equal(model.errors.length, 1);
  assert.match(model.errors[0], /validation\.json/);
});
