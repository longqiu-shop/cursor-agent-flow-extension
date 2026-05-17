import { validateStepStatusArtifact, STEP_STATUS_SCHEMA_ID } from './schemas/stepStatusSchema';
import {
  AUDIT_SCHEMA_ID,
  MASTER_PLAN_SCHEMA_ID,
  MEMORY_PROPOSAL_SCHEMA_ID,
  OUTPUT_CONTRACT_SCHEMA_ID,
  PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID,
  PLAN_RUN_SCHEMA_ID,
  PLAN_VALIDATION_SCHEMA_ID,
  TOOL_INVENTORY_SCHEMA_ID,
  TOOL_USE_EVIDENCE_SCHEMA_ID,
  TRACE_EVENT_SCHEMA_ID,
  validateAuditArtifact,
  validateMasterPlan,
  validateMemoryProposal,
  validateOutputContract,
  validatePlanAmendmentProposal,
  validatePlanRun,
  validatePlanValidationArtifact,
  validateToolInventory,
  validateToolUseEvidence,
  validateTraceEvent
} from './planSchemas';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export function createWorkflowSchemaRegistry(): WorkflowSchemaRegistry {
  const registry = new WorkflowSchemaRegistry();
  registry.register(STEP_STATUS_SCHEMA_ID, validateStepStatusArtifact);
  registry.register(MASTER_PLAN_SCHEMA_ID, validateMasterPlan);
  registry.register(AUDIT_SCHEMA_ID, validateAuditArtifact);
  registry.register(PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID, validatePlanAmendmentProposal);
  registry.register(TOOL_INVENTORY_SCHEMA_ID, validateToolInventory);
  registry.register(MEMORY_PROPOSAL_SCHEMA_ID, validateMemoryProposal);
  registry.register(OUTPUT_CONTRACT_SCHEMA_ID, validateOutputContract);
  registry.register(TOOL_USE_EVIDENCE_SCHEMA_ID, validateToolUseEvidence);
  registry.register(PLAN_VALIDATION_SCHEMA_ID, validatePlanValidationArtifact);
  registry.register(PLAN_RUN_SCHEMA_ID, validatePlanRun);
  registry.register(TRACE_EVENT_SCHEMA_ID, validateTraceEvent);
  return registry;
}

export {
  AUDIT_SCHEMA_ID,
  MASTER_PLAN_SCHEMA_ID,
  MEMORY_PROPOSAL_SCHEMA_ID,
  OUTPUT_CONTRACT_SCHEMA_ID,
  PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID,
  PLAN_RUN_SCHEMA_ID,
  PLAN_VALIDATION_SCHEMA_ID,
  TOOL_INVENTORY_SCHEMA_ID,
  TOOL_USE_EVIDENCE_SCHEMA_ID,
  TRACE_EVENT_SCHEMA_ID,
  STEP_STATUS_SCHEMA_ID,
  validateAuditArtifact,
  validateMasterPlan,
  validateMemoryProposal,
  validateOutputContract,
  validatePlanAmendmentProposal,
  validatePlanRun,
  validatePlanValidationArtifact,
  validateStepStatusArtifact,
  validateToolInventory,
  validateToolUseEvidence,
  validateTraceEvent
};
