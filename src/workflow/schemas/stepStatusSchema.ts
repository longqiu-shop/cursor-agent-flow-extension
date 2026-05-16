import { StepStatusArtifact } from '../../types';
import { SchemaValidationResult } from '../workflowSchemaRegistry';

export const STEP_STATUS_SCHEMA_ID = 'workflow.stepStatus';

export function validateStepStatusArtifact(value: unknown): SchemaValidationResult<StepStatusArtifact> {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ['workflow.stepStatus must be an object']
    };
  }

  if (value.status !== 'blocked' && value.status !== 'failed') {
    errors.push('workflow.stepStatus.status must be "blocked" or "failed"');
  }

  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    errors.push('workflow.stepStatus.reason is required');
  }

  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? {
      status: value.status as StepStatusArtifact['status'],
      reason: value.reason as string
    } : undefined,
    errors
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
