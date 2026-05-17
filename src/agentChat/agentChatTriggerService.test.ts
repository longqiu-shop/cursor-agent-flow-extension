import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentChatTriggerResult,
  AgentChatTriggerService,
  listAgentChatRequestFiles
} from './agentChatTriggerService';

function tempRequestsDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-agent-chat-triggers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requestsDir = path.join(dir, 'agent-flow-requests');
  fs.mkdirSync(requestsDir, { recursive: true });
  return requestsDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function requestPath(requestsDir: string, requestId: string): string {
  return path.join(requestsDir, `${requestId}.json`);
}

function resultPath(requestsDir: string, requestId: string): string {
  return path.join(requestsDir, `${requestId}.result.json`);
}

function readResult(requestsDir: string, requestId: string): AgentChatTriggerResult {
  return JSON.parse(fs.readFileSync(resultPath(requestsDir, requestId), 'utf-8')) as AgentChatTriggerResult;
}

test('starts workflow for a valid request and writes exact started result', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000000';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: '  Summarize today\'s git changes  '
  });
  const goals: string[] = [];
  const service = new AgentChatTriggerService(async goal => {
    goals.push(goal);
    return 'run_123';
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.deepEqual(goals, ['Summarize today\'s git changes']);
  assert.deepEqual(result, {
    requestId,
    status: 'started',
    runId: 'run_123'
  });
  assert.deepEqual(readResult(requestsDir, requestId), result);
});

test('rejects extra top-level fields without starting workflow', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000001';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: 'Summarize today\'s git changes',
    unexpected: true
  });
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return 'run_unreachable';
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.equal(calls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, requestId);
  assert.match(result.error ?? '', /exactly these top-level fields: goal, requestId, type/);
  assert.deepEqual(readResult(requestsDir, requestId), result);
});

test('rejects requestId mismatch with filename without starting workflow', async t => {
  const requestsDir = tempRequestsDir(t);
  const fileRequestId = 'start-agentic-workflow-1700000000002';
  const bodyRequestId = 'start-agentic-workflow-1700000000003';
  writeJson(requestPath(requestsDir, fileRequestId), {
    type: 'startAgenticWorkflow',
    requestId: bodyRequestId,
    goal: 'Summarize today\'s git changes'
  });
  const service = new AgentChatTriggerService(async () => 'run_unreachable');

  const result = await service.processRequestFile(requestPath(requestsDir, fileRequestId));

  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, fileRequestId);
  assert.match(result.error ?? '', new RegExp(`expected ${fileRequestId}, received ${bodyRequestId}`));
  assert.deepEqual(readResult(requestsDir, fileRequestId), result);
});

test('rejects blank goals without starting workflow', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000007';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: '   '
  });
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return 'run_unreachable';
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.equal(calls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, requestId);
  assert.match(result.error ?? '', /goal must be a non-empty string/);
});

test('rejects request ids outside the expected trigger format', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'manual-trigger';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: 'Summarize today\'s git changes'
  });
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return 'run_unreachable';
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.equal(calls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, requestId);
  assert.match(result.error ?? '', /start-agentic-workflow-<timestamp> format/);
});

test('does not start the same request twice or overwrite the started result', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000004';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: 'Summarize today\'s git changes'
  });
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return `run_${calls}`;
  });

  const first = await service.processRequestFile(requestPath(requestsDir, requestId));
  const second = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.equal(calls, 1);
  assert.deepEqual(first, {
    requestId,
    status: 'started',
    runId: 'run_1'
  });
  assert.deepEqual(second, {
    requestId,
    status: 'ignored',
    error: `Request already processed: ${requestId}`
  });
  assert.deepEqual(readResult(requestsDir, requestId), first);
});

test('does not restart a request that already has a result file', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000008';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: 'Summarize today\'s git changes'
  });
  const existingResult: AgentChatTriggerResult = {
    requestId,
    status: 'started',
    runId: 'run_existing'
  };
  writeJson(resultPath(requestsDir, requestId), existingResult);
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return 'run_unreachable';
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    requestId,
    status: 'ignored',
    error: `Result already exists for request: ${requestId}`
  });
  assert.deepEqual(readResult(requestsDir, requestId), existingResult);
});

test('writes failed result when workflow start throws', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000005';
  writeJson(requestPath(requestsDir, requestId), {
    type: 'startAgenticWorkflow',
    requestId,
    goal: 'Summarize today\'s git changes'
  });
  const service = new AgentChatTriggerService(async () => {
    throw new Error('workflow registry unavailable');
  });

  const result = await service.processRequestFile(requestPath(requestsDir, requestId));

  assert.deepEqual(result, {
    requestId,
    status: 'failed',
    error: 'workflow registry unavailable'
  });
  assert.deepEqual(readResult(requestsDir, requestId), result);
});

test('ignores result files without writing nested result files', async t => {
  const requestsDir = tempRequestsDir(t);
  const requestId = 'start-agentic-workflow-1700000000006';
  writeJson(resultPath(requestsDir, requestId), {
    requestId,
    status: 'started',
    runId: 'run_existing'
  });
  let calls = 0;
  const service = new AgentChatTriggerService(async () => {
    calls += 1;
    return 'run_unreachable';
  });

  const result = await service.processRequestFile(resultPath(requestsDir, requestId));

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    requestId: `${requestId}.result`,
    status: 'ignored',
    error: 'Not an agent chat trigger request file'
  });
  assert.equal(fs.existsSync(path.join(requestsDir, `${requestId}.result.result.json`)), false);
});

test('lists existing request files while skipping result files and non-json files', t => {
  const requestsDir = tempRequestsDir(t);
  const firstRequestId = 'start-agentic-workflow-1700000000009';
  const secondRequestId = 'start-agentic-workflow-1700000000010';
  writeJson(requestPath(requestsDir, firstRequestId), {
    type: 'startAgenticWorkflow',
    requestId: firstRequestId,
    goal: 'Summarize today\'s git changes'
  });
  writeJson(requestPath(requestsDir, secondRequestId), {
    type: 'startAgenticWorkflow',
    requestId: secondRequestId,
    goal: 'Review the open PR'
  });
  writeJson(resultPath(requestsDir, firstRequestId), {
    requestId: firstRequestId,
    status: 'started',
    runId: 'run_existing'
  });
  fs.writeFileSync(path.join(requestsDir, 'notes.txt'), 'not a request', 'utf-8');

  const files = listAgentChatRequestFiles(requestsDir).map(filePath => path.basename(filePath));

  assert.deepEqual(files.sort(), [
    `${firstRequestId}.json`,
    `${secondRequestId}.json`
  ]);
});

test('returns no existing request files when the directory is absent', () => {
  const missingDir = path.join(process.cwd(), 'missing-agent-chat-request-dir');

  assert.deepEqual(listAgentChatRequestFiles(missingDir), []);
});
