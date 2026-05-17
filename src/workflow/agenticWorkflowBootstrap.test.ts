import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowDefinition } from '../types';
import { validateWorkflowDefinition } from './workflowValidation';
import { createWorkflowSchemaRegistry } from './workflowSchemas';

test('validates the project override agentic workflow bootstrap fixture', () => {
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

test('validates the extension-owned agentic workflow bootstrap asset', () => {
  const workflowPath = path.resolve(process.cwd(), 'src/assets/workflows/agentic-workflow-bootstrap.json');
  const workflow = {
    ...JSON.parse(fs.readFileSync(workflowPath, 'utf-8')),
    filePath: workflowPath
  } as WorkflowDefinition;

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(workflow.steps.map(step => step.type), ['toolInventory', 'agent', 'planRuntime']);
  assert.equal(workflow.steps[1].input?.promptFile, '../prompts/agentic-workflow-planner.md');
});

test('copies extension-owned workflow assets into package output', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const vscodeIgnore = fs.readFileSync(path.resolve(process.cwd(), '.vscodeignore'), 'utf-8');

  assert.match(manifest.scripts.compile, /copy:assets/);
  assert.match(manifest.scripts['copy:assets'], /src\/assets/);
  assert.match(vscodeIgnore, /!out\/assets\/\*\*/);
});

test('does not require a project-local skill for the agentic workflow trigger', () => {
  const skillPath = path.resolve(process.cwd(), '.cursor/skills/start-agentic-workflow/SKILL.md');

  assert.equal(fs.existsSync(skillPath), false);
});
