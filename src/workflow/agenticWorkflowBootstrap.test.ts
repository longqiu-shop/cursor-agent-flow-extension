import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowDefinition } from '../types';
import { validateWorkflowDefinition } from './workflowValidation';
import { createWorkflowSchemaRegistry } from './workflowSchemas';

test('validates the concrete agentic workflow bootstrap fixture', () => {
  const workflowPath = path.resolve(process.cwd(), '.cursor/workflows/agentic-workflow-bootstrap.json');
  const workflow = {
    ...JSON.parse(fs.readFileSync(workflowPath, 'utf-8')),
    filePath: workflowPath
  } as WorkflowDefinition;

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(workflow.steps.map(step => step.type), ['toolInventory', 'agent', 'planRuntime']);
  assert.equal(workflow.steps[2].input?.planArtifact, '{{ steps.planner.outputArtifact }}');
  assert.equal(workflow.steps[2].input?.toolInventoryArtifact, '{{ steps.inventory.outputArtifact }}');
});
