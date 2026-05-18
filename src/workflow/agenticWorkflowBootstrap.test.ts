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
  assert.deepEqual(workflow.steps.map(step => step.type), ['workflowPreferences', 'toolInventory', 'agent', 'planRuntime']);
  assert.equal(workflow.steps[0].output?.path, 'preferences/workflow-preferences.json');
  assert.deepEqual(workflow.steps[1].input?.include, ['skills', 'agents', 'commands', 'workflowPrimitives', 'runtimeActions', 'mcpTools', 'workflowPreferences']);
  assert.equal(workflow.steps[3].input?.planArtifact, '{{ steps.planner.outputArtifact }}');
  assert.equal(workflow.steps[3].input?.toolInventoryArtifact, '{{ steps.inventory.outputArtifact }}');
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
  assert.deepEqual(workflow.steps.map(step => step.type), ['workflowPreferences', 'toolInventory', 'agent', 'planRuntime']);
  assert.equal(workflow.steps[2].input?.promptFile, '../prompts/agentic-workflow-planner.md');
});

test('validates the extension-owned ready-plan workflow asset', () => {
  const workflowPath = path.resolve(process.cwd(), 'src/assets/workflows/agentic-workflow-ready-plan.json');
  const workflow = {
    ...JSON.parse(fs.readFileSync(workflowPath, 'utf-8')),
    filePath: workflowPath
  } as WorkflowDefinition;

  const result = validateWorkflowDefinition(workflow, createWorkflowSchemaRegistry());

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(workflow.steps.map(step => step.type), ['planImport', 'toolInventory', 'planRuntime']);
  assert.deepEqual(workflow.steps[1].input?.include, ['skills', 'agents', 'commands', 'workflowPrimitives', 'runtimeActions', 'mcpTools', 'workflowPreferences']);
  assert.equal(workflow.steps[0].input?.planPath, '{{ trigger.planPath }}');
  assert.equal(workflow.steps[2].input?.planArtifact, '{{ steps.import-plan.outputArtifact }}');
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

test('extension-owned planner prompt describes task-boundary splitting rules', () => {
  const promptPath = path.resolve(process.cwd(), 'src/assets/prompts/agentic-workflow-planner.md');
  const prompt = fs.readFileSync(promptPath, 'utf-8');

  assert.match(prompt, /Each task represents at most one agent invocation/);
  assert.match(prompt, /reviewer and verifier/);
  assert.match(prompt, /independent verification/);
  assert.match(prompt, /separate one-agent tasks/);
  assert.match(prompt, /Workflow preferences artifact/);
  assert.match(prompt, /selectedPreferenceIds/);
  assert.match(prompt, /Do not put "workflowPreferences\.\*" inventory ids in task tools/);
  assert.match(prompt, /PR review pattern: candidate review -> independent verification -> synthesis -> optional posting side-effect/);
  assert.match(prompt, /Design review pattern: draft\/design summary -> architecture critique -> QA critique -> independent verification -> optional revision/);
});

test('project-local planner prompt keeps task-boundary guidance in sync with extension prompt', () => {
  const promptPath = path.resolve(process.cwd(), '.cursor/workflows/agentic-workflow-planner.md');
  const prompt = fs.readFileSync(promptPath, 'utf-8');

  assert.match(prompt, /Each task represents at most one agent invocation/);
  assert.match(prompt, /reviewer and verifier/);
  assert.match(prompt, /PR review pattern: candidate review -> independent verification -> synthesis -> optional posting side-effect/);
  assert.match(prompt, /workflowPreferences\.selectedPreferenceIds/);
});

test('does not require a project-local skill for the agentic workflow trigger', () => {
  const skillPath = path.resolve(process.cwd(), '.cursor/skills/start-agentic-workflow/SKILL.md');

  assert.equal(fs.existsSync(skillPath), false);
});
