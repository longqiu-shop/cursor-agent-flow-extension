import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowPreferenceProvider } from './workflowPreferenceProvider';
import type { WorkflowPreferenceEntry } from './planSchemas';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-preferences-'));
}

function preferenceById(preferences: WorkflowPreferenceEntry[], id: string): WorkflowPreferenceEntry {
  const preference = preferences.find(entry => entry.id === id);
  assert.ok(preference, `Expected preference ${id}`);
  return preference;
}

test('includes built-in default workflow preferences by default', () => {
  const snapshot = new WorkflowPreferenceProvider().snapshot();
  const builtIn = preferenceById(snapshot.preferences, 'default-task-boundaries');

  assert.equal(builtIn.source, 'builtInDefault');
  assert.match(builtIn.content, /one role, one goal/);
});

test('discovers project workflow preferences', () => {
  const projectDir = tempDir();
  fs.writeFileSync(path.join(projectDir, 'review.md'), [
    '---',
    'title: Review Flow',
    'summary: Split PR reviews into review and verify tasks.',
    '---',
    '# Review Flow',
    'Prefer review, verify, synthesize, then post stages.'
  ].join('\n'), 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({ builtInDefaults: [], projectDirectories: [projectDir] }).snapshot();

  assert.deepEqual(snapshot.preferences.map(preference => preference.id), ['review']);
  assert.equal(snapshot.preferences[0].source, 'project');
  assert.equal(snapshot.preferences[0].title, 'Review Flow');
  assert.match(snapshot.preferences[0].content, /verify, synthesize/);
});

test('discovers global workflow preferences', () => {
  const globalDir = tempDir();
  fs.writeFileSync(path.join(globalDir, 'no-post.md'), 'Do not post review comments unless explicitly asked.', 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({ builtInDefaults: [], globalDirectories: [globalDir] }).snapshot();

  assert.deepEqual(snapshot.preferences.map(preference => preference.id), ['no-post']);
  assert.equal(snapshot.preferences[0].source, 'global');
  assert.match(snapshot.preferences[0].summary, /Do not post/);
});

test('project workflow preference overrides global preference with same id', () => {
  const globalDir = tempDir();
  const projectDir = tempDir();
  fs.writeFileSync(path.join(globalDir, 'review.md'), 'Use the global review preference.', 'utf-8');
  fs.writeFileSync(path.join(projectDir, 'review.md'), 'Use the project review preference.', 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({
    builtInDefaults: [],
    globalDirectories: [globalDir],
    projectDirectories: [projectDir]
  }).snapshot();

  assert.equal(snapshot.preferences.length, 1);
  assert.equal(snapshot.preferences[0].source, 'project');
  assert.equal(snapshot.preferences[0].content, 'Use the project review preference.');
  assert.deepEqual(snapshot.overriddenPreferenceIds, ['review']);
});

test('invalid and empty workflow preference files are skipped without breaking discovery', () => {
  const projectDir = tempDir();
  fs.writeFileSync(path.join(projectDir, 'empty.md'), '\n\n', 'utf-8');
  fs.writeFileSync(path.join(projectDir, 'broken.json'), '{ nope', 'utf-8');
  fs.writeFileSync(path.join(projectDir, 'valid.md'), '# Valid\nKeep plans small.', 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({ builtInDefaults: [], projectDirectories: [projectDir] }).snapshot();

  assert.deepEqual(snapshot.preferences.map(preference => preference.id), ['valid']);
  assert.equal(snapshot.skipped?.length, 2);
});

test('run override takes precedence over project and global workflow preferences', () => {
  const globalDir = tempDir();
  const projectDir = tempDir();
  fs.writeFileSync(path.join(globalDir, 'review.md'), 'Use global review preference.', 'utf-8');
  fs.writeFileSync(path.join(projectDir, 'review.md'), 'Use project review preference.', 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({
    builtInDefaults: [],
    globalDirectories: [globalDir],
    projectDirectories: [projectDir],
    overrides: [{
      id: 'review',
      content: 'Use run-specific review preference.'
    }]
  }).snapshot();

  assert.equal(snapshot.preferences.length, 1);
  assert.equal(snapshot.preferences[0].source, 'runOverride');
  assert.equal(snapshot.preferences[0].content, 'Use run-specific review preference.');
  assert.deepEqual(snapshot.overriddenPreferenceIds, ['review']);
});

test('built-in defaults are present and can be overridden by global, project, and run preferences', () => {
  const globalDir = tempDir();
  const projectDir = tempDir();
  fs.writeFileSync(path.join(globalDir, 'review.md'), 'Use global review preference.', 'utf-8');
  fs.writeFileSync(path.join(projectDir, 'review.md'), 'Use project review preference.', 'utf-8');

  const snapshot = new WorkflowPreferenceProvider({
    builtInDefaults: [{
      id: 'review',
      title: 'Built-in Review',
      summary: 'Built-in review preference.',
      content: 'Use built-in review preference.'
    }],
    globalDirectories: [globalDir],
    projectDirectories: [projectDir],
    overrides: [{
      id: 'review',
      content: 'Use run-specific review preference.'
    }]
  }).snapshot();

  const review = preferenceById(snapshot.preferences, 'review');
  assert.equal(review.source, 'runOverride');
  assert.equal(review.content, 'Use run-specific review preference.');
  assert.deepEqual(snapshot.overriddenPreferenceIds, ['review']);
});
