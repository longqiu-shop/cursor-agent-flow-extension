import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredRefsForTraceEvent,
  TRACE_EVENTS,
  TraceEventType,
  validateTraceEventRefs
} from './traceEvents';

test('every typed trace event declares required reference metadata', () => {
  const eventTypes = Object.values(TRACE_EVENTS) as TraceEventType[];

  assert.equal(new Set(eventTypes).size, eventTypes.length);
  for (const eventType of eventTypes) {
    assert.equal(requiredRefsForTraceEvent(eventType).length > 0, true, eventType);
  }
});

test('typed trace event validation rejects missing required references', () => {
  assert.deepEqual(validateTraceEventRefs(TRACE_EVENTS.TASK_VALIDATED, {
    stageId: 'execute',
    taskId: 'complete-goal',
    status: 'passed'
  }), [
    'Trace event task.validated requires ref "artifacts"'
  ]);

  assert.deepEqual(validateTraceEventRefs(TRACE_EVENTS.TASK_VALIDATED, {
    stageId: 'execute',
    taskId: 'complete-goal',
    status: 'passed',
    artifacts: [{ path: 'tasks/execute/complete-goal/validation.json' }]
  }), []);
});
