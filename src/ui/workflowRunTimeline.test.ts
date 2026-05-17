import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWorkflowRunTimeline } from './workflowRunTimeline';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-ui-timeline-'));
}

test('loads plan timeline events from trace.json', () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, 'trace.json'), JSON.stringify({
    schemaVersion: '1',
    eventCount: 2,
    events: [
      {
        schemaVersion: '1',
        id: 'event-1',
        type: 'planRuntime.started',
        timestamp: '2026-05-16T00:00:00.000Z',
        refs: {
          status: 'validating'
        }
      },
      {
        schemaVersion: '1',
        id: 'event-2',
        type: 'task.completed',
        timestamp: '2026-05-16T00:00:01.000Z',
        refs: {
          status: 'succeeded',
          stageId: 'execute',
          taskId: 'complete-goal',
          artifacts: [{ path: 'tasks/execute/complete-goal/output.md' }]
        }
      }
    ]
  }), 'utf-8');

  const timeline = loadWorkflowRunTimeline(runDir);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].type, 'planRuntime.started');
  assert.equal(timeline[0].summary, 'status: validating');
  assert.equal(timeline[1].summary, 'status: succeeded, stageId: execute, taskId: complete-goal, artifacts: 1');
});

test('returns empty timeline when trace.json is absent or malformed', () => {
  const runDir = tempRunDir();

  assert.deepEqual(loadWorkflowRunTimeline(runDir), []);

  fs.writeFileSync(path.join(runDir, 'trace.json'), '{not json', 'utf-8');
  assert.deepEqual(loadWorkflowRunTimeline(runDir), []);
});
