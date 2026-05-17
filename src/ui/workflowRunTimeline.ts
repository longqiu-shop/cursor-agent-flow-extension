import * as fs from 'fs';
import * as path from 'path';

export interface WorkflowRunTimelineEvent {
  id: string;
  type: string;
  timestamp: string;
  summary: string;
}

interface TraceIndex {
  events?: Array<{
    id?: unknown;
    type?: unknown;
    timestamp?: unknown;
    refs?: unknown;
  }>;
}

export function loadWorkflowRunTimeline(runDir: string): WorkflowRunTimelineEvent[] {
  const tracePath = path.join(runDir, 'trace.json');
  if (!fs.existsSync(tracePath)) {
    return [];
  }

  let parsed: TraceIndex;
  try {
    parsed = JSON.parse(fs.readFileSync(tracePath, 'utf-8')) as TraceIndex;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.events)) {
    return [];
  }

  return parsed.events.flatMap(event => {
    if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.timestamp !== 'string') {
      return [];
    }

    return [{
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      summary: summarizeTraceRefs(event.refs)
    }];
  });
}

function summarizeTraceRefs(refs: unknown): string {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
    return '';
  }

  const record = refs as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['status', 'stageId', 'taskId', 'reason']) {
    if (typeof record[key] === 'string' && record[key].trim().length > 0) {
      parts.push(`${key}: ${record[key]}`);
    }
  }

  const artifacts = record.artifacts;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    parts.push(`artifacts: ${artifacts.length}`);
  }

  return parts.join(', ');
}
