import { validateStepStatusArtifact, STEP_STATUS_SCHEMA_ID } from './schemas/stepStatusSchema';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export function createWorkflowSchemaRegistry(): WorkflowSchemaRegistry {
  const registry = new WorkflowSchemaRegistry();
  registry.register(STEP_STATUS_SCHEMA_ID, validateStepStatusArtifact);
  return registry;
}

export {
  STEP_STATUS_SCHEMA_ID,
  validateStepStatusArtifact
};
