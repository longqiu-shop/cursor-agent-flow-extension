import * as fs from 'fs';
import * as path from 'path';
import {
  PLAN_SCHEMA_VERSION,
  TraceEvent,
  validateTraceEvent
} from './planSchemas';
import { TraceEventType, validateTraceEventRefs } from './traceEvents';

export interface TraceStoreOptions {
  now?: () => string;
}

export interface TraceIndex {
  schemaVersion: '1';
  eventCount: number;
  events: TraceEvent[];
}

export interface ArtifactLineageIndex {
  schemaVersion: '1';
  artifacts: Array<{
    path: string;
    eventId: string;
    hash?: string;
  }>;
}

export class TraceStore {
  private nextEventNumber = 1;

  constructor(
    private readonly runDir: string,
    private readonly options: TraceStoreOptions = {}
  ) {
    if (!path.isAbsolute(runDir)) {
      throw new Error(`runDir must be absolute: ${runDir}`);
    }
    this.nextEventNumber = this.findNextEventNumber();
  }

  append(type: string, refs: Record<string, unknown> = {}, parentIds: string[] = []): TraceEvent {
    this.nextEventNumber = Math.max(this.nextEventNumber, this.findNextEventNumber());
    const event: TraceEvent = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: `event-${this.nextEventNumber++}`,
      type,
      timestamp: this.options.now?.() ?? new Date().toISOString(),
      ...(parentIds.length > 0 ? { parentIds } : {}),
      ...(Object.keys(refs).length > 0 ? { refs } : {})
    };

    const validation = validateTraceEvent(event);
    if (!validation.valid) {
      throw new Error(`Invalid trace event: ${validation.errors.join('; ')}`);
    }

    fs.mkdirSync(this.runDir, { recursive: true });
    fs.appendFileSync(this.eventsPath(), `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  appendTyped(type: TraceEventType, refs: Record<string, unknown>, parentIds: string[] = []): TraceEvent {
    const errors = validateTraceEventRefs(type, refs);
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    return this.append(type, refs, parentIds);
  }

  rebuildIndexes(): TraceIndex {
    const events = this.readEvents();
    const traceIndex: TraceIndex = {
      schemaVersion: '1',
      eventCount: events.length,
      events
    };

    this.writeJsonAtomic(this.tracePath(), traceIndex);
    this.writeJsonAtomic(this.lineagePath(), this.buildArtifactLineage(events));
    this.writeDecisionLog(events);
    return traceIndex;
  }

  readEvents(): TraceEvent[] {
    if (!fs.existsSync(this.eventsPath())) {
      return [];
    }

    const events: TraceEvent[] = [];
    const lines = fs.readFileSync(this.eventsPath(), 'utf-8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.trim().length === 0) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`events.jsonl line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }

      const validation = validateTraceEvent(parsed);
      if (!validation.valid || !validation.value) {
        throw new Error(`events.jsonl line ${index + 1} is invalid: ${validation.errors.join('; ')}`);
      }
      events.push(validation.value);
    });

    return events;
  }

  private buildArtifactLineage(events: TraceEvent[]): ArtifactLineageIndex {
    const artifacts: ArtifactLineageIndex['artifacts'] = [];
    for (const event of events) {
      const refs = event.refs ?? {};
      const artifactRefs = refs.artifacts;
      if (!Array.isArray(artifactRefs)) {
        continue;
      }

      for (const artifact of artifactRefs) {
        if (!artifact || typeof artifact !== 'object') {
          continue;
        }
        const record = artifact as Record<string, unknown>;
        if (typeof record.path !== 'string') {
          continue;
        }
        this.assertRunRelativeArtifactPath(record.path);
        artifacts.push({
          path: record.path,
          eventId: event.id,
          ...(typeof record.hash === 'string' ? { hash: record.hash } : {})
        });
      }
    }

    return {
      schemaVersion: '1',
      artifacts
    };
  }

  private writeDecisionLog(events: TraceEvent[]): void {
    const lines = [
      '# Decision Log',
      ''
    ];

    for (const event of events) {
      lines.push(`- ${event.timestamp} ${event.type}${this.describeEvent(event)}`);
    }

    this.writeTextAtomic(this.decisionLogPath(), `${lines.join('\n')}\n`);
  }

  private describeEvent(event: TraceEvent): string {
    const refs = event.refs ?? {};
    if (typeof refs.reason === 'string') {
      return `: ${refs.reason}`;
    }
    if (typeof refs.status === 'string') {
      return `: ${refs.status}`;
    }
    return '';
  }

  private assertRunRelativeArtifactPath(artifactPath: string): void {
    if (!artifactPath || path.isAbsolute(artifactPath)) {
      throw new Error(`Trace artifact path must be relative to runDir: ${artifactPath}`);
    }
    const normalized = path.normalize(artifactPath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
      throw new Error(`Trace artifact path must not escape runDir: ${artifactPath}`);
    }
  }

  private eventsPath(): string {
    return path.join(this.runDir, 'events.jsonl');
  }

  private findNextEventNumber(): number {
    if (!fs.existsSync(this.eventsPath())) {
      return 1;
    }

    let highestEventNumber = 0;
    const lines = fs.readFileSync(this.eventsPath(), 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (typeof parsed.id !== 'string') {
          continue;
        }
        const match = /^event-(\d+)$/.exec(parsed.id);
        if (!match) {
          continue;
        }
        highestEventNumber = Math.max(highestEventNumber, Number(match[1]));
      } catch {
        // Keep append best-effort; rebuildIndexes still reports corrupted history.
      }
    }
    return highestEventNumber + 1;
  }

  private tracePath(): string {
    return path.join(this.runDir, 'trace.json');
  }

  private lineagePath(): string {
    return path.join(this.runDir, 'artifact-lineage.json');
  }

  private decisionLogPath(): string {
    return path.join(this.runDir, 'decision-log.md');
  }

  private writeJsonAtomic(filePath: string, value: unknown): void {
    this.writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private writeTextAtomic(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
}
