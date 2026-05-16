import * as path from 'path';
import { ArtifactSpec, WorkflowDefinition, WorkflowStep } from '../types';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

const WORKFLOW_STEP_TYPES = new Set(['agent', 'readJson', 'fanout', 'join']);

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition, schemaRegistry?: WorkflowSchemaRegistry): WorkflowValidationResult {
  const errors: string[] = [];

  if (!workflow.id || typeof workflow.id !== 'string') {
    errors.push('Workflow id is required');
  }

  if (!workflow.name || typeof workflow.name !== 'string') {
    errors.push(`Workflow ${workflow.id || '<unknown>'} name is required`);
  }

  if (!Number.isInteger(workflow.version) || workflow.version <= 0) {
    errors.push(`Workflow ${workflow.id || '<unknown>'} version must be a positive integer`);
  }

  if (workflow.defaults?.fanoutConcurrency && workflow.defaults.fanoutConcurrency !== 'sequential') {
    errors.push(`Workflow ${workflow.id} fanoutConcurrency "${workflow.defaults.fanoutConcurrency}" is not yet supported`);
  }

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push(`Workflow ${workflow.id || '<unknown>'} must define at least one step`);
  } else {
    errors.push(...validateSteps(workflow.steps, schemaRegistry));
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateSteps(steps: WorkflowStep[], schemaRegistry?: WorkflowSchemaRegistry): string[] {
  const errors: string[] = [];
  const stepIds = new Set<string>();

  for (const step of steps) {
    if (!step.id || typeof step.id !== 'string') {
      errors.push('Workflow step id is required');
      continue;
    }

    if (stepIds.has(step.id)) {
      errors.push(`Duplicate workflow step id: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!WORKFLOW_STEP_TYPES.has(step.type)) {
      errors.push(`Unsupported workflow step type "${step.type}" for step ${step.id}`);
    }

    if (step.timeoutSeconds !== undefined && (!Number.isFinite(step.timeoutSeconds) || step.timeoutSeconds <= 0)) {
      errors.push(`Step ${step.id} timeoutSeconds must be a positive number`);
    }

    if (step.output) {
      errors.push(...validateArtifactSpec(step.output, `step ${step.id}`, schemaRegistry));
    }

    errors.push(...validateStepInput(step, schemaRegistry));
  }

  return errors;
}

function validateStepInput(step: WorkflowStep, schemaRegistry?: WorkflowSchemaRegistry): string[] {
  const errors: string[] = [];
  const input = step.input ?? {};

  switch (step.type) {
    case 'agent':
      if (typeof input.title !== 'string' || input.title.trim().length === 0) {
        errors.push(`Agent step ${step.id} input.title is required`);
      }
      if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
        errors.push(`Agent step ${step.id} input.prompt is required`);
      }
      break;
    case 'readJson':
      if (typeof input.path !== 'string' || input.path.trim().length === 0) {
        errors.push(`readJson step ${step.id} input.path is required`);
      } else {
        errors.push(...validateArtifactPath(input.path, `readJson step ${step.id} input.path`));
      }
      if (input.select !== undefined && typeof input.select !== 'string') {
        errors.push(`readJson step ${step.id} input.select must be a dot-path string`);
      }
      if (input.schema !== undefined) {
        errors.push(...validateSchemaId(input.schema, `readJson step ${step.id} input.schema`, schemaRegistry));
      }
      break;
    case 'fanout':
      if (typeof input.itemsFrom !== 'string' || input.itemsFrom.trim().length === 0) {
        errors.push(`fanout step ${step.id} input.itemsFrom is required`);
      }
      errors.push(...validateFanoutChildSteps(step, input, schemaRegistry));
      break;
    case 'join':
      if (typeof input.from !== 'string' || input.from.trim().length === 0) {
        errors.push(`join step ${step.id} input.from is required`);
      }
      if (typeof input.outputPath !== 'string' || input.outputPath.trim().length === 0) {
        errors.push(`join step ${step.id} input.outputPath is required`);
      } else {
        errors.push(...validateArtifactPath(input.outputPath, `join step ${step.id} input.outputPath`));
      }
      break;
  }

  return errors;
}

function validateFanoutChildSteps(
  step: WorkflowStep,
  input: Record<string, unknown>,
  schemaRegistry?: WorkflowSchemaRegistry
): string[] {
  const errors: string[] = [];
  const hasStep = input.step !== undefined;
  const hasSteps = input.steps !== undefined;

  if (hasStep && hasSteps) {
    errors.push(`fanout step ${step.id} input must use either step or steps, not both`);
    return errors;
  }

  if (hasStep) {
    if (!isWorkflowStep(input.step)) {
      return [`fanout step ${step.id} input.step must be a workflow step`];
    }
    return validateFanoutStepList(step.id, [input.step], schemaRegistry);
  }

  if (hasSteps) {
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      return [`fanout step ${step.id} input.steps must be a non-empty array of workflow steps`];
    }
    if (!input.steps.every(isWorkflowStep)) {
      return [`fanout step ${step.id} input.steps must contain only workflow steps`];
    }
    return validateFanoutStepList(step.id, input.steps, schemaRegistry);
  }

  errors.push(`fanout step ${step.id} input.step or input.steps is required`);
  return errors;
}

function validateFanoutStepList(
  fanoutStepId: string,
  childSteps: WorkflowStep[],
  schemaRegistry?: WorkflowSchemaRegistry
): string[] {
  const errors: string[] = [];
  if (childSteps.some(childStep => childStep.type === 'fanout')) {
    errors.push(`Nested fanout is not supported in step ${fanoutStepId}`);
    return errors;
  }
  errors.push(...validateSteps(childSteps, schemaRegistry));
  return errors;
}

function validateArtifactSpec(spec: ArtifactSpec, label: string, schemaRegistry?: WorkflowSchemaRegistry): string[] {
  const errors = validateArtifactPath(spec.path, `${label} output.path`);

  if (!['json', 'markdown', 'text'].includes(spec.format)) {
    errors.push(`${label} output.format must be json, markdown, or text`);
  }

  if (spec.schema !== undefined) {
    errors.push(...validateSchemaId(spec.schema, `${label} output.schema`, schemaRegistry));
  }

  return errors;
}

function validateSchemaId(value: unknown, label: string, schemaRegistry?: WorkflowSchemaRegistry): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [`${label} must be a non-empty string when provided`];
  }

  if (value === 'none' || !schemaRegistry || schemaRegistry.has(value)) {
    return [];
  }

  return [`${label} is not registered: ${value}`];
}

export function validateArtifactPath(artifactPath: string, label = 'artifact path'): string[] {
  const errors: string[] = [];

  if (!artifactPath || artifactPath.trim().length === 0) {
    errors.push(`${label} is required`);
    return errors;
  }

  if (path.isAbsolute(artifactPath)) {
    errors.push(`${label} must be relative to runDir`);
  }

  const normalized = path.normalize(artifactPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    errors.push(`${label} must not traverse outside runDir`);
  }

  return errors;
}

function isWorkflowStep(value: unknown): value is WorkflowStep {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const maybeStep = value as Partial<WorkflowStep>;
  return typeof maybeStep.id === 'string' && typeof maybeStep.type === 'string';
}
