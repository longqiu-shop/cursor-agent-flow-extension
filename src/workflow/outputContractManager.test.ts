import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OUTPUT_CONTRACT_ERROR_CODES, OutputContractManager } from './outputContractManager';
import { createWorkflowSchemaRegistry } from './workflowSchemas';
import type { ArtifactSpec } from '../types';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-output-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

const expectedMarkdown: ArtifactSpec = {
  path: 'tasks/summarize/summarize-changes/output.md',
  format: 'markdown',
  required: true
};

test('builds prompt instructions with tmp and final output paths', () => {
  const runDir = tempRunDir();
  const manager = new OutputContractManager(runDir, createWorkflowSchemaRegistry());
  const instructions = manager.buildPromptInstructions([expectedMarkdown], {}, {
    statusPath: path.join(runDir, 'status/task.json')
  });

  assert.match(instructions, /Task output contract/);
  assert.match(instructions, /output\.md\.tmp/);
  assert.match(instructions, /output\.md/);
  assert.match(instructions, /status\/task\.json/);
});

test('validates declared outputs and allows known task artifacts', () => {
  const runDir = tempRunDir();
  const manager = new OutputContractManager(runDir, createWorkflowSchemaRegistry());
  writeFile(path.join(runDir, expectedMarkdown.path), '# Summary\n');
  writeFile(path.join(runDir, 'tasks/summarize/summarize-changes/input-context.json'), '{}');
  writeFile(path.join(runDir, 'tasks/summarize/summarize-changes/submission-debug.json'), '{}');

  const result = manager.validateDeclaredOutputs([expectedMarkdown], {}, {
    taskArtifactDir: 'tasks/summarize/summarize-changes',
    allowlist: [
      'tasks/summarize/summarize-changes/input-context.json',
      'tasks/summarize/summarize-changes/submission-debug.json'
    ]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checkedArtifacts, [path.join(runDir, expectedMarkdown.path)]);
});

test('reports missing final output when only tmp artifact exists', () => {
  const runDir = tempRunDir();
  const manager = new OutputContractManager(runDir, createWorkflowSchemaRegistry());
  writeFile(path.join(runDir, `${expectedMarkdown.path}.tmp`), '# Partial\n');

  const result = manager.validateDeclaredOutputs([expectedMarkdown], {});

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(error => error.code), [
    OUTPUT_CONTRACT_ERROR_CODES.TEMP_ARTIFACT_PRESENT
  ]);
});

test('validates JSON output schemas and detects unexpected artifacts', () => {
  const runDir = tempRunDir();
  const manager = new OutputContractManager(runDir, createWorkflowSchemaRegistry());
  const jsonOutput: ArtifactSpec = {
    path: 'tasks/summarize/summarize-changes/tool-inventory.json',
    format: 'json',
    schema: 'tool-inventory@1'
  };
  writeFile(path.join(runDir, jsonOutput.path), '{"schemaVersion":"1","tools":"bad"}\n');
  writeFile(path.join(runDir, 'tasks/summarize/summarize-changes/extra.md'), 'extra');

  const result = manager.validateDeclaredOutputs([jsonOutput], {}, {
    taskArtifactDir: 'tasks/summarize/summarize-changes'
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(error => error.code), [
    OUTPUT_CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED,
    OUTPUT_CONTRACT_ERROR_CODES.UNEXPECTED_ARTIFACT
  ]);
});

test('rejects output paths that escape the run directory', () => {
  const runDir = tempRunDir();
  const manager = new OutputContractManager(runDir, createWorkflowSchemaRegistry());
  const result = manager.validateDeclaredOutputs([
    {
      path: '../outside.md',
      format: 'markdown'
    }
  ], {});

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(error => error.code), [
    OUTPUT_CONTRACT_ERROR_CODES.PATH_ESCAPES_RUN_DIR
  ]);
});
