import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  PLAN_SCHEMA_VERSION,
  WorkflowPreferenceEntry,
  WorkflowPreferenceSkippedEntry,
  WorkflowPreferencesArtifact
} from './planSchemas';

export const WORKFLOW_PREFERENCES_DIR = '.cursor/agent-flow/preferences';

export interface WorkflowPreferenceOverride {
  id: string;
  title?: string;
  summary?: string;
  content: string;
}

export interface WorkflowPreferenceProviderOptions {
  builtInDefaults?: WorkflowPreferenceOverride[];
  projectDirectories?: string[];
  globalDirectories?: string[];
  overrides?: WorkflowPreferenceOverride[];
}

export interface WorkflowPreferenceSnapshot extends WorkflowPreferencesArtifact {
  resolvedPreferenceIds: string[];
  overriddenPreferenceIds: string[];
}

interface ParsedPreference {
  id: string;
  title: string;
  summary: string;
  content: string;
}

export const BUILT_IN_WORKFLOW_PREFERENCES: WorkflowPreferenceOverride[] = [
  {
    id: 'default-task-boundaries',
    title: 'Default Task Boundaries',
    summary: 'Prefer one role per task and split review, verification, synthesis, and side effects.',
    content: [
      'Each task should represent at most one agent invocation with one role, one goal, and one output contract.',
      'Split producer, reviewer, verifier, synthesizer, reviser, and poster responsibilities into separate tasks.',
      'If a task performs side effects such as posting comments, require prior validation evidence as input.'
    ].join('\n')
  }
];

export class WorkflowPreferenceProvider {
  constructor(private readonly options: WorkflowPreferenceProviderOptions = {}) {}

  snapshot(overrides: WorkflowPreferenceOverride[] = []): WorkflowPreferenceSnapshot {
    const skipped: WorkflowPreferenceSkippedEntry[] = [];
    const preferencesById = new Map<string, WorkflowPreferenceEntry>();
    const overriddenPreferenceIds = new Set<string>();

    for (const builtInDefault of this.options.builtInDefaults ?? BUILT_IN_WORKFLOW_PREFERENCES) {
      const parsed = this.parseOverride(builtInDefault, skipped, 'builtInDefault');
      if (!parsed) {
        continue;
      }
      preferencesById.set(parsed.id, this.toEntry(parsed, 'builtInDefault'));
    }
    for (const directory of this.options.globalDirectories ?? []) {
      this.discoverDirectory(directory, 'global', preferencesById, overriddenPreferenceIds, skipped);
    }
    for (const directory of this.options.projectDirectories ?? []) {
      this.discoverDirectory(directory, 'project', preferencesById, overriddenPreferenceIds, skipped);
    }
    for (const override of [...(this.options.overrides ?? []), ...overrides]) {
      const parsed = this.parseOverride(override, skipped, 'runOverride');
      if (!parsed) {
        continue;
      }
      if (preferencesById.has(parsed.id)) {
        overriddenPreferenceIds.add(parsed.id);
      }
      preferencesById.set(parsed.id, this.toEntry(parsed, 'runOverride'));
    }

    const preferences = Array.from(preferencesById.values()).sort((a, b) => a.id.localeCompare(b.id));
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      preferences,
      ...(skipped.length > 0 ? { skipped } : {}),
      resolvedPreferenceIds: preferences.map(preference => preference.id),
      overriddenPreferenceIds: Array.from(overriddenPreferenceIds).sort()
    };
  }

  private discoverDirectory(
    directory: string,
    source: WorkflowPreferenceEntry['source'],
    preferencesById: Map<string, WorkflowPreferenceEntry>,
    overriddenPreferenceIds: Set<string>,
    skipped: WorkflowPreferenceSkippedEntry[]
  ): void {
    if (!this.isDirectory(directory)) {
      return;
    }

    for (const filePath of this.listPreferenceFiles(directory)) {
      const parsed = this.parseFile(filePath, skipped);
      if (!parsed) {
        continue;
      }
      if (preferencesById.has(parsed.id)) {
        overriddenPreferenceIds.add(parsed.id);
      }
      preferencesById.set(parsed.id, this.toEntry(parsed, source, filePath));
    }
  }

  private listPreferenceFiles(directory: string): string[] {
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(md|markdown|json)$/i.test(entry.name))
        .map(entry => path.join(directory, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private parseFile(filePath: string, skipped: WorkflowPreferenceSkippedEntry[]): ParsedPreference | undefined {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      skipped.push({ path: filePath, reason: 'Unable to read preference file' });
      return undefined;
    }

    if (/\.json$/i.test(filePath)) {
      return this.parseJsonPreference(filePath, content, skipped);
    }
    return this.parseMarkdownPreference(filePath, content, skipped);
  }

  private parseMarkdownPreference(filePath: string, rawContent: string, skipped: WorkflowPreferenceSkippedEntry[]): ParsedPreference | undefined {
    const { frontmatter, body } = this.extractFrontmatter(rawContent);
    const content = body.trim();
    if (!content) {
      skipped.push({ path: filePath, reason: 'Preference file is empty' });
      return undefined;
    }

    const fallbackId = this.inferIdFromPath(filePath);
    const id = this.safePreferenceId(this.firstString(frontmatter.id, fallbackId));
    if (!id) {
      skipped.push({ path: filePath, reason: 'Preference file has no usable id' });
      return undefined;
    }
    const title = this.firstString(frontmatter.title, this.firstHeading(content), this.titleFromId(id));
    const summary = this.firstString(frontmatter.summary, frontmatter.description, this.firstContentLine(content), title);
    return {
      id,
      title,
      summary: this.truncate(summary, 240),
      content
    };
  }

  private parseJsonPreference(filePath: string, rawContent: string, skipped: WorkflowPreferenceSkippedEntry[]): ParsedPreference | undefined {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>;
    } catch {
      skipped.push({ path: filePath, reason: 'Preference JSON is invalid' });
      return undefined;
    }

    const content = this.firstString(parsed.content, parsed.instructions, parsed.preference).trim();
    if (!content) {
      skipped.push({ path: filePath, reason: 'Preference JSON has no content' });
      return undefined;
    }

    const fallbackId = this.inferIdFromPath(filePath);
    const id = this.safePreferenceId(this.firstString(parsed.id, fallbackId));
    if (!id) {
      skipped.push({ path: filePath, reason: 'Preference JSON has no usable id' });
      return undefined;
    }
    const title = this.firstString(parsed.title, this.titleFromId(id));
    const summary = this.firstString(parsed.summary, parsed.description, this.firstContentLine(content), title);
    return {
      id,
      title,
      summary: this.truncate(summary, 240),
      content
    };
  }

  private parseOverride(
    override: WorkflowPreferenceOverride,
    skipped: WorkflowPreferenceSkippedEntry[],
    source: WorkflowPreferenceEntry['source']
  ): ParsedPreference | undefined {
    const id = this.safePreferenceId(override.id);
    const content = override.content.trim();
    if (!id || !content) {
      skipped.push({ path: `${source}:${override.id || '<missing-id>'}`, reason: 'Preference override must have id and content' });
      return undefined;
    }
    const title = this.firstString(override.title, this.titleFromId(id));
    return {
      id,
      title,
      summary: this.truncate(this.firstString(override.summary, this.firstContentLine(content), title), 240),
      content
    };
  }

  private toEntry(
    preference: ParsedPreference,
    source: WorkflowPreferenceEntry['source'],
    filePath?: string
  ): WorkflowPreferenceEntry {
    return {
      id: preference.id,
      source,
      ...(filePath ? { path: filePath } : {}),
      title: preference.title,
      summary: preference.summary,
      content: preference.content,
      contentSha256: crypto.createHash('sha256').update(preference.content).digest('hex')
    };
  }

  private extractFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const parsed = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (parsed) {
        frontmatter[parsed[1]] = parsed[2].replace(/^['"]|['"]$/g, '').trim();
      }
    }
    return { frontmatter, body: content.slice(match[0].length) };
  }

  private firstHeading(content: string): string {
    return content.split(/\r?\n/)
      .map(line => line.match(/^#\s+(.+)$/)?.[1]?.trim() ?? '')
      .find(line => line.length > 0) ?? '';
  }

  private firstContentLine(content: string): string {
    return content.split(/\r?\n/)
      .map(line => line.replace(/^#+\s*/, '').trim())
      .find(line => line.length > 0) ?? '';
  }

  private inferIdFromPath(filePath: string): string {
    return this.safePreferenceId(path.basename(filePath, path.extname(filePath)));
  }

  private safePreferenceId(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private titleFromId(id: string): string {
    return id.split(/[-_.]+/).filter(Boolean).map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ') || 'Workflow Preference';
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
  }

  private firstString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return '';
  }

  private isDirectory(directory: string): boolean {
    try {
      return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  }
}
