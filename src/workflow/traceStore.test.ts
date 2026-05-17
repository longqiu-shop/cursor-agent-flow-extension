import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from './traceStore';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-trace-'));
}

test('appends trace events and rebuilds derived indexes', () => {
  const runDir = tempRunDir();
  const store = new TraceStore(runDir, {
    now: () => '2026-05-16T00:00:00.000Z'
  });

  store.append('planRuntime.started', { status: 'validating' });
  store.append('task.completed', {
    status: 'succeeded',
    artifacts: [{ path: 'tasks/summarize/output.md', hash: 'abc123' }]
  });

  const index = store.rebuildIndexes();
  const lineage = JSON.parse(fs.readFileSync(path.join(runDir, 'artifact-lineage.json'), 'utf-8')) as {
    artifacts: Array<{ path: string; eventId: string; hash?: string }>;
  };
  const decisionLog = fs.readFileSync(path.join(runDir, 'decision-log.md'), 'utf-8');

  assert.equal(index.eventCount, 2);
  assert.deepEqual(index.events.map(event => event.id), ['event-1', 'event-2']);
  assert.deepEqual(lineage.artifacts, [{
    path: 'tasks/summarize/output.md',
    eventId: 'event-2',
    hash: 'abc123'
  }]);
  assert.match(decisionLog, /planRuntime\.started/);
  assert.match(decisionLog, /task\.completed/);
});

test('continues event numbering when appending to an existing events file', () => {
  const runDir = tempRunDir();
  const firstStore = new TraceStore(runDir, {
    now: () => '2026-05-16T00:00:00.000Z'
  });
  firstStore.append('agentSubmission.queued');

  const secondStore = new TraceStore(runDir, {
    now: () => '2026-05-16T00:00:01.000Z'
  });
  secondStore.append('agentSubmission.submitting');

  const events = secondStore.readEvents();
  assert.deepEqual(events.map(event => event.id), ['event-1', 'event-2']);
});

test('avoids duplicate event ids when stores append interleaved events', () => {
  const runDir = tempRunDir();
  const planRuntimeStore = new TraceStore(runDir);
  planRuntimeStore.append('planRuntime.started');

  const agentStepStore = new TraceStore(runDir);
  agentStepStore.append('agentSubmission.queued');
  planRuntimeStore.append('planRuntime.completed');

  const events = planRuntimeStore.readEvents();
  assert.deepEqual(events.map(event => event.id), ['event-1', 'event-2', 'event-3']);
});

test('rejects corrupted events when rebuilding indexes', () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '{"schemaVersion":"1","id":"event-1"\n', 'utf-8');
  const store = new TraceStore(runDir);

  assert.throws(() => store.rebuildIndexes(), /not valid JSON/);
});

test('rejects artifact lineage entries outside the run directory', () => {
  const runDir = tempRunDir();
  const store = new TraceStore(runDir);
  store.append('artifact.produced', {
    artifacts: [{ path: '../outside.md' }]
  });

  assert.throws(() => store.rebuildIndexes(), /must not escape runDir/);
});
