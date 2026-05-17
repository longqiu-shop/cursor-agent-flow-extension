import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWorkflowRunDebugFiles } from './workflowRunDebugInfo';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-ui-debug-info-'));
}

test('loads debug files recursively from the workflow run directory', () => {
  const runDir = tempRunDir();
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '{"id":"event-1"}\n', 'utf-8');
  fs.writeFileSync(path.join(runDir, 'trace.json'), '{"events":[]}\n', 'utf-8');
  fs.mkdirSync(path.join(runDir, 'tasks', 'execute'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tasks', 'execute', 'output.md'), '# Output\n', 'utf-8');

  const files = loadWorkflowRunDebugFiles(runDir);

  assert.deepEqual(files.map(file => file.relativePath), [
    'events.jsonl',
    'tasks/execute/output.md',
    'trace.json'
  ]);
  assert.equal(files[0].absolutePath, path.join(runDir, 'events.jsonl'));
  assert.equal(files[0].sizeBytes, 17);
  assert.match(files[0].modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('returns no debug files when the run directory is unavailable', () => {
  assert.deepEqual(loadWorkflowRunDebugFiles(path.join(os.tmpdir(), 'missing-run-dir')), []);
  assert.deepEqual(loadWorkflowRunDebugFiles('relative-run-dir'), []);
});
