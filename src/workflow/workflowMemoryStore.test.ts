import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowMemoryStore } from './workflowMemoryStore';
import type { MasterPlan, ToolInventory } from './planSchemas';

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-memory-'));
}

const plan: MasterPlan = {
  schemaVersion: '1',
  objective: 'Summarize changes',
  riskLevel: 'low',
  allowedCapabilities: ['read'],
  stages: [
    {
      id: 'summarize',
      tasks: [
        {
          id: 'summarize-changes',
          type: 'agent',
          goal: 'Summarize changes',
          successCriteria: ['Summary exists'],
          evidenceRequired: ['tasks/summarize/summarize-changes/output.md'],
          confidencePolicy: {
            requireAllCriteria: true,
            requireAllEvidence: true,
            onFailure: 'block'
          },
          expectedOutputs: [
            {
              path: 'tasks/summarize/summarize-changes/output.md',
              format: 'markdown'
            }
          ],
          tools: ['workflow.readJson']
        }
      ]
    }
  ]
};

const inventory: ToolInventory = {
  schemaVersion: '1',
  tools: [
    {
      id: 'workflow.readJson',
      source: 'workflowPrimitives',
      capabilities: ['read']
    },
    {
      id: 'workflow.agent',
      source: 'workflowPrimitives',
      capabilities: ['workspaceWrite']
    }
  ]
};

test('creates declaration-only task input context with selected memory and tools', () => {
  const runDir = tempRunDir();
  const store = new WorkflowMemoryStore(runDir);
  store.seedRunMemory({
    trigger: 'manual',
    secret: 'do-not-include'
  });
  store.writePlanMemory(plan);

  const result = store.createInputContext('summarize', plan.stages[0].tasks[0], inventory, {
    runMemoryKeys: ['trigger'],
    planMemoryKeys: ['objective']
  });

  assert.equal(result.path, path.join(runDir, 'tasks/summarize/summarize-changes/input-context.json'));
  assert.deepEqual(result.value.memory.run, { trigger: 'manual' });
  assert.deepEqual(result.value.memory.plan, { objective: 'Summarize changes' });
  assert.deepEqual(result.value.tools.map(tool => tool.id), ['workflow.readJson']);
  assert.equal(typeof result.value.provenance.memoryHash, 'string');
  assert.equal(fs.existsSync(result.path), true);
});

test('rejects run directories that are not absolute', () => {
  assert.throws(() => new WorkflowMemoryStore('relative-run-dir'), /runDir must be absolute/);
});
