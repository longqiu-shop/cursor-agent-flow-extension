import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TASK_RUNTIME_ARTIFACT_NAMES } from './taskRuntimeArtifacts';

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

test('README command labels match package contributions for agentic workflow commands', () => {
  const readme = readWorkspaceFile('README.md');
  const manifest = JSON.parse(readWorkspaceFile('package.json')) as {
    contributes?: { commands?: Array<{ command: string; title: string }> };
  };
  const agenticCommands = (manifest.contributes?.commands ?? [])
    .filter(command => command.command.startsWith('cursorAgentFlow.startAgenticWorkflow'));

  for (const command of agenticCommands) {
    assert.match(readme, new RegExp(escapeRegExp(command.title)));
  }
});

test('README documents runtime-owned task artifact names', () => {
  const readme = readWorkspaceFile('README.md');

  for (const artifactName of Object.values(TASK_RUNTIME_ARTIFACT_NAMES)) {
    assert.match(readme, new RegExp(escapeRegExp(artifactName)));
  }
  assert.match(readme, /startAgenticWorkflowFromPlanDocument/);
  assert.match(readme, /start-agentic-workflow-YYYYMMDDHHmmss/);
  assert.doesNotMatch(readme, /start-agentic-workflow-from-plan-document-<timestamp>/);
  assert.match(readme, /~\/\.cursor\/agent-flow-requests\//);
  assert.match(readme, /\.cursor\/agent-flow\/preferences\//);
  assert.match(readme, /preferences\/workflow-preferences\.json/);
  assert.match(readme, /workflowPreferences\.selectedPreferenceIds/);
  assert.match(readme, /run override -> project -> global -> built-in default/);
  assert.match(readme, /docs\/phase2-smoke-evidence\.md/);
  assert.doesNotMatch(readme, /Agent Schedules view/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
