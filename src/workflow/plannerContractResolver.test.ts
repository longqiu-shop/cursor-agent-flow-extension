import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkflowDefinition } from '../types';
import {
  createPlannerContractMetadata,
  getExtensionDefaultWorkflowDirectories,
  sha256
} from './plannerContractResolver';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planner-contract-'));
}

test('creates planner contract metadata with stable prompt hash', () => {
  const dir = tempDir();
  const workflowPath = path.join(dir, 'agentic-workflow-bootstrap.json');
  const promptPath = path.join(dir, 'agentic-workflow-planner.md');
  fs.writeFileSync(promptPath, 'Plan {{ trigger.goal }}\n', 'utf-8');

  const workflow: WorkflowDefinition = {
    id: 'agentic-workflow-bootstrap',
    name: 'Agentic Workflow Bootstrap',
    filePath: workflowPath,
    version: 1,
    steps: [
      {
        id: 'planner',
        type: 'agent',
        input: {
          title: 'Plan',
          promptFile: 'agentic-workflow-planner.md'
        },
        output: {
          path: 'plan/master-plan.json',
          format: 'json',
          schema: 'none'
        }
      }
    ]
  };

  const metadata = createPlannerContractMetadata(workflow, {
    source: 'extension-default',
    extensionVersion: '1.2.3',
    now: () => '2026-05-16T00:00:00.000Z'
  });

  assert.deepEqual(metadata, {
    contractId: 'agentic-workflow-planner',
    contractVersion: '1',
    source: 'extension-default',
    workflowPath,
    promptPath,
    sha256: sha256('Plan {{ trigger.goal }}\n'),
    resolvedAt: '2026-05-16T00:00:00.000Z',
    extensionVersion: '1.2.3'
  });
});

test('returns extension default workflow directories in packaged then source order', () => {
  assert.deepEqual(getExtensionDefaultWorkflowDirectories('/extension'), [
    path.join('/extension', 'out', 'assets', 'workflows'),
    path.join('/extension', 'src', 'assets', 'workflows')
  ]);
});

test('does not attach metadata for non-agentic workflows', () => {
  const workflow: WorkflowDefinition = {
    id: 'other-workflow',
    name: 'Other Workflow',
    filePath: '/tmp/workflow.json',
    version: 1,
    steps: []
  };

  assert.equal(createPlannerContractMetadata(workflow, { source: 'project-override' }), undefined);
});
