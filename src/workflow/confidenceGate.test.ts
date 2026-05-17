import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfidenceGate } from './confidenceGate';
import type { AuditArtifact, PlanTask } from './planSchemas';
import type { OutputValidationResult } from './outputContractManager';

const task: PlanTask = {
  id: 'summarize',
  type: 'agent',
  goal: 'Summarize changes',
  successCriteria: ['Summary exists'],
  evidenceRequired: ['tasks/summarize/output.md'],
  confidencePolicy: {
    requireAllCriteria: true,
    requireAllEvidence: true,
    onFailure: 'block'
  },
  expectedOutputs: [
    {
      path: 'tasks/summarize/output.md',
      format: 'markdown'
    }
  ]
};

const validOutputs: OutputValidationResult = {
  valid: true,
  checkedArtifacts: ['/tmp/run/tasks/summarize/output.md'],
  errors: []
};

const passingAudit: AuditArtifact = {
  schemaVersion: '1',
  criteriaResults: [
    {
      criterion: 'Summary exists',
      passed: true,
      evidence: ['/tmp/run/tasks/summarize/output.md']
    }
  ],
  missingEvidence: [],
  risks: [],
  nextAction: 'advance'
};

test('passes when outputs, criteria, evidence, and next action all pass', () => {
  const result = new ConfidenceGate().evaluate(task, passingAudit, validOutputs);

  assert.equal(result.passed, true);
  assert.equal(result.status, 'succeeded');
});

test('blocks when required evidence is missing', () => {
  const result = new ConfidenceGate().evaluate(task, {
    ...passingAudit,
    missingEvidence: ['tasks/summarize/output.md']
  }, validOutputs);

  assert.equal(result.passed, false);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason ?? '', /Required evidence missing/);
});

test('maps needsApproval policy to needsApproval status', () => {
  const result = new ConfidenceGate().evaluate({
    ...task,
    confidencePolicy: {
      ...task.confidencePolicy,
      onFailure: 'needsApproval'
    }
  }, {
    ...passingAudit,
    nextAction: 'needsApproval'
  }, validOutputs);

  assert.equal(result.passed, false);
  assert.equal(result.status, 'needsApproval');
});

test('fails retry policy without performing runtime retry in MVP', () => {
  const result = new ConfidenceGate().evaluate({
    ...task,
    confidencePolicy: {
      ...task.confidencePolicy,
      onFailure: 'retry'
    }
  }, passingAudit, {
    valid: false,
    checkedArtifacts: [],
    errors: [{
      code: 'MISSING_REQUIRED_OUTPUT',
      message: 'missing output'
    }]
  });

  assert.equal(result.passed, false);
  assert.equal(result.status, 'failed');
});
