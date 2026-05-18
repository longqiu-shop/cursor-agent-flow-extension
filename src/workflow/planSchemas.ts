import { ArtifactSpec } from '../types';
import { SchemaValidationResult } from './workflowSchemaRegistry';

export const PLAN_SCHEMA_VERSION = '1';
export const MASTER_PLAN_SCHEMA_ID = 'master-plan@1';
export const AUDIT_SCHEMA_ID = 'audit@1';
export const PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID = 'plan-amendment-proposal@1';
export const TOOL_INVENTORY_SCHEMA_ID = 'tool-inventory@1';
export const MEMORY_PROPOSAL_SCHEMA_ID = 'memory-proposal@1';
export const OUTPUT_CONTRACT_SCHEMA_ID = 'output-contract@1';
export const TOOL_USE_EVIDENCE_SCHEMA_ID = 'tool-use-evidence@1';
export const WORKFLOW_PREFERENCES_SCHEMA_ID = 'workflow-preferences@1';
export const PLAN_VALIDATION_SCHEMA_ID = 'plan-validation@1';
export const PLAN_RUN_SCHEMA_ID = 'plan-run@1';
export const TRACE_EVENT_SCHEMA_ID = 'trace-event@1';

const EXPECTED_OUTPUT_KEYS = new Set(['format', 'path', 'required', 'schema']);

export type PlanRiskLevel = 'low' | 'medium' | 'high';
export type PlanFailureAction = 'block' | 'retry' | 'needsApproval';
export type PlanTaskType = 'agent';
export type PlanRunStatus =
  | 'pending'
  | 'validating'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'needsApproval'
  | 'cancelled';
export type PlanStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped';
export type PlanTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'needsApproval' | 'cancelled';

export interface PlanConfidencePolicy {
  requireAllCriteria: boolean;
  requireAllEvidence: boolean;
  onFailure: PlanFailureAction;
}

export interface PlanTaskBoundary {
  role?: string;
  maxAgentInvocations?: number;
  description?: string;
}

export interface PlanTask {
  id: string;
  type: PlanTaskType;
  goal: string;
  role?: string;
  taskBoundary?: PlanTaskBoundary;
  dependsOn?: string[];
  inputArtifacts?: string[];
  outputPurpose?: string;
  scope?: Record<string, unknown>;
  nonGoals?: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  confidencePolicy: PlanConfidencePolicy;
  expectedOutputs: ArtifactSpec[];
  tools?: string[];
}

export interface PlanStage {
  id: string;
  name?: string;
  tasks: PlanTask[];
}

export interface MasterPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  objective: string;
  riskLevel: PlanRiskLevel;
  allowedCapabilities: string[];
  stages: PlanStage[];
  workflowPreferences?: PlanWorkflowPreferences;
  requiresApproval?: boolean;
}

export interface PlanWorkflowPreferences {
  selectedPreferenceIds: string[];
  interpretedRequirements: string[];
  conflicts?: string[];
}

export interface PlanValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface PlanValidationArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  valid: boolean;
  errors: PlanValidationError[];
  warnings?: PlanValidationError[];
}

export type ToolInventorySource = 'skills' | 'agents' | 'commands' | 'workflowPrimitives' | 'runtimeActions' | 'mcpTools' | 'workflowPreferences';

export interface ToolInventoryEntry {
  id: string;
  source: ToolInventorySource;
  capabilities: string[];
  description?: string;
  path?: string;
  title?: string;
  summary?: string;
}

export interface ToolInventory {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  generatedAt?: string;
  tools: ToolInventoryEntry[];
}

export interface AuditCriterionResult {
  criterion: string;
  passed: boolean;
  evidence: string[];
}

export interface AuditArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  criteriaResults: AuditCriterionResult[];
  missingEvidence: string[];
  risks: string[];
  nextAction: 'advance' | 'block' | 'retry' | 'needsApproval';
}

export interface MemoryProposalEntry {
  key: string;
  sourceArtifact: string;
  value: unknown;
  safeToRetain: boolean;
  mayContainSecrets: boolean;
}

export interface MemoryProposalArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  proposals: MemoryProposalEntry[];
}

export interface OutputContractArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  expectedOutputs: ArtifactSpec[];
}

export interface ToolUseEvidenceArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  selectedTools: string[];
  usedTools: string[];
  attemptedTools: string[];
  unavailableTools: string[];
  fallbackSources: string[];
  evidence: string[];
  notes?: string;
}

export type WorkflowPreferenceSource = 'builtInDefault' | 'global' | 'project' | 'runOverride';

export interface WorkflowPreferenceEntry {
  id: string;
  source: WorkflowPreferenceSource;
  path?: string;
  title: string;
  summary: string;
  content: string;
  contentSha256: string;
}

export interface WorkflowPreferenceSkippedEntry {
  path: string;
  reason: string;
}

export interface WorkflowPreferencesArtifact {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  generatedAt?: string;
  preferences: WorkflowPreferenceEntry[];
  skipped?: WorkflowPreferenceSkippedEntry[];
}

export interface TraceEvent {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  id: string;
  type: string;
  timestamp: string;
  parentIds?: string[];
  refs?: Record<string, unknown>;
}

export interface PlanRunStage {
  stageRunId: string;
  stageId: string;
  status: PlanStageStatus;
}

export interface PlanRunTask {
  taskRunId: string;
  taskId: string;
  stageId: string;
  status: PlanTaskStatus;
}

export interface PlanRun {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  status: PlanRunStatus;
  planId?: string;
  planHash?: string;
  currentStageId?: string;
  currentTaskId?: string;
  startedAt?: string;
  finishedAt?: string;
  blockReason?: string;
  stages?: PlanRunStage[];
  tasks?: PlanRunTask[];
}

export function validateMasterPlan(value: unknown): SchemaValidationResult<MasterPlan> {
  const errors: string[] = [];
  const plan = expectRecord(value, MASTER_PLAN_SCHEMA_ID, errors);
  if (!plan) {
    return invalid(errors);
  }

  validateSchemaVersion(plan, MASTER_PLAN_SCHEMA_ID, errors);
  requireNonEmptyString(plan, 'objective', `${MASTER_PLAN_SCHEMA_ID}.objective`, errors);
  requireEnum(plan, 'riskLevel', ['low', 'medium', 'high'], `${MASTER_PLAN_SCHEMA_ID}.riskLevel`, errors);
  requireStringArray(plan, 'allowedCapabilities', `${MASTER_PLAN_SCHEMA_ID}.allowedCapabilities`, errors);
  validatePlanStages(plan.stages, errors);

  if (plan.requiresApproval !== undefined && typeof plan.requiresApproval !== 'boolean') {
    errors.push(`${MASTER_PLAN_SCHEMA_ID}.requiresApproval must be boolean`);
  }
  if (plan.workflowPreferences !== undefined) {
    validatePlanWorkflowPreferences(plan.workflowPreferences, `${MASTER_PLAN_SCHEMA_ID}.workflowPreferences`, errors);
  }

  return finish<MasterPlan>(value, errors);
}

export function validateAuditArtifact(value: unknown): SchemaValidationResult<AuditArtifact> {
  const errors: string[] = [];
  const audit = expectRecord(value, AUDIT_SCHEMA_ID, errors);
  if (!audit) {
    return invalid(errors);
  }

  validateSchemaVersion(audit, AUDIT_SCHEMA_ID, errors);
  validateCriteriaResults(audit.criteriaResults, `${AUDIT_SCHEMA_ID}.criteriaResults`, errors);
  requireStringArray(audit, 'missingEvidence', `${AUDIT_SCHEMA_ID}.missingEvidence`, errors, true);
  requireStringArray(audit, 'risks', `${AUDIT_SCHEMA_ID}.risks`, errors, true);
  requireEnum(audit, 'nextAction', ['advance', 'block', 'retry', 'needsApproval'], `${AUDIT_SCHEMA_ID}.nextAction`, errors);

  return finish<AuditArtifact>(value, errors);
}

export function validatePlanAmendmentProposal(value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  const proposal = expectRecord(value, PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID, errors);
  if (!proposal) {
    return invalid(errors);
  }

  validateSchemaVersion(proposal, PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID, errors);
  requireNonEmptyString(proposal, 'reason', `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.reason`, errors);
  requireStringArray(proposal, 'triggeringEvidence', `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.triggeringEvidence`, errors);
  requireNonEmptyString(proposal, 'changeSummary', `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.changeSummary`, errors);
  requireStringArray(proposal, 'affectedStages', `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.affectedStages`, errors);
  requireEnum(proposal, 'riskChange', ['none', 'increased', 'decreased'], `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.riskChange`, errors);
  requireStringArray(proposal, 'capabilityChanges', `${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.capabilityChanges`, errors, true);
  if (!isRecord(proposal.proposedDiff)) {
    errors.push(`${PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID}.proposedDiff must be object`);
  }

  return finish(value, errors);
}

export function validateToolInventory(value: unknown): SchemaValidationResult<ToolInventory> {
  const errors: string[] = [];
  const inventory = expectRecord(value, TOOL_INVENTORY_SCHEMA_ID, errors);
  if (!inventory) {
    return invalid(errors);
  }

  validateSchemaVersion(inventory, TOOL_INVENTORY_SCHEMA_ID, errors);
  validateToolEntries(inventory.tools, errors);

  if (inventory.generatedAt !== undefined && typeof inventory.generatedAt !== 'string') {
    errors.push(`${TOOL_INVENTORY_SCHEMA_ID}.generatedAt must be string`);
  }

  return finish<ToolInventory>(value, errors);
}

export function validateMemoryProposal(value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  const artifact = expectRecord(value, MEMORY_PROPOSAL_SCHEMA_ID, errors);
  if (!artifact) {
    return invalid(errors);
  }

  validateSchemaVersion(artifact, MEMORY_PROPOSAL_SCHEMA_ID, errors);
  if (!Array.isArray(artifact.proposals) || artifact.proposals.length === 0) {
    errors.push(`${MEMORY_PROPOSAL_SCHEMA_ID}.proposals must be a non-empty array`);
  } else {
    artifact.proposals.forEach((proposal, index) => validateMemoryProposalEntry(proposal, index, errors));
  }

  return finish(value, errors);
}

export function validateOutputContract(value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  const contract = expectRecord(value, OUTPUT_CONTRACT_SCHEMA_ID, errors);
  if (!contract) {
    return invalid(errors);
  }

  validateSchemaVersion(contract, OUTPUT_CONTRACT_SCHEMA_ID, errors);
  validateExpectedOutputs(contract.expectedOutputs, `${OUTPUT_CONTRACT_SCHEMA_ID}.expectedOutputs`, errors);

  return finish(value, errors);
}

export function validateToolUseEvidence(value: unknown): SchemaValidationResult<ToolUseEvidenceArtifact> {
  const errors: string[] = [];
  const artifact = expectRecord(value, TOOL_USE_EVIDENCE_SCHEMA_ID, errors);
  if (!artifact) {
    return invalid(errors);
  }

  validateSchemaVersion(artifact, TOOL_USE_EVIDENCE_SCHEMA_ID, errors);
  requireStringArray(artifact, 'selectedTools', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.selectedTools`, errors);
  requireStringArray(artifact, 'usedTools', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.usedTools`, errors, true);
  requireStringArray(artifact, 'attemptedTools', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.attemptedTools`, errors, true);
  requireStringArray(artifact, 'unavailableTools', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.unavailableTools`, errors, true);
  requireStringArray(artifact, 'fallbackSources', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.fallbackSources`, errors, true);
  requireStringArray(artifact, 'evidence', `${TOOL_USE_EVIDENCE_SCHEMA_ID}.evidence`, errors);
  if (artifact.notes !== undefined && typeof artifact.notes !== 'string') {
    errors.push(`${TOOL_USE_EVIDENCE_SCHEMA_ID}.notes must be string`);
  }

  return finish<ToolUseEvidenceArtifact>(value, errors);
}

export function validateWorkflowPreferences(value: unknown): SchemaValidationResult<WorkflowPreferencesArtifact> {
  const errors: string[] = [];
  const artifact = expectRecord(value, WORKFLOW_PREFERENCES_SCHEMA_ID, errors);
  if (!artifact) {
    return invalid(errors);
  }

  validateSchemaVersion(artifact, WORKFLOW_PREFERENCES_SCHEMA_ID, errors);
  if (artifact.generatedAt !== undefined && typeof artifact.generatedAt !== 'string') {
    errors.push(`${WORKFLOW_PREFERENCES_SCHEMA_ID}.generatedAt must be string`);
  }
  if (!Array.isArray(artifact.preferences)) {
    errors.push(`${WORKFLOW_PREFERENCES_SCHEMA_ID}.preferences must be array`);
  } else {
    artifact.preferences.forEach((preference, index) => validateWorkflowPreferenceEntry(preference, `${WORKFLOW_PREFERENCES_SCHEMA_ID}.preferences[${index}]`, errors));
  }
  if (artifact.skipped !== undefined) {
    if (!Array.isArray(artifact.skipped)) {
      errors.push(`${WORKFLOW_PREFERENCES_SCHEMA_ID}.skipped must be array`);
    } else {
      artifact.skipped.forEach((skipped, index) => validateWorkflowPreferenceSkippedEntry(skipped, `${WORKFLOW_PREFERENCES_SCHEMA_ID}.skipped[${index}]`, errors));
    }
  }

  return finish<WorkflowPreferencesArtifact>(value, errors);
}

export function validatePlanValidationArtifact(value: unknown): SchemaValidationResult<PlanValidationArtifact> {
  const errors: string[] = [];
  const artifact = expectRecord(value, PLAN_VALIDATION_SCHEMA_ID, errors);
  if (!artifact) {
    return invalid(errors);
  }

  validateSchemaVersion(artifact, PLAN_VALIDATION_SCHEMA_ID, errors);
  if (typeof artifact.valid !== 'boolean') {
    errors.push(`${PLAN_VALIDATION_SCHEMA_ID}.valid must be boolean`);
  }
  validateValidationErrors(artifact.errors, `${PLAN_VALIDATION_SCHEMA_ID}.errors`, errors);
  if (artifact.warnings !== undefined) {
    validateValidationErrors(artifact.warnings, `${PLAN_VALIDATION_SCHEMA_ID}.warnings`, errors);
  }

  return finish<PlanValidationArtifact>(value, errors);
}

export function validatePlanRun(value: unknown): SchemaValidationResult<PlanRun> {
  const errors: string[] = [];
  const run = expectRecord(value, PLAN_RUN_SCHEMA_ID, errors);
  if (!run) {
    return invalid(errors);
  }

  validateSchemaVersion(run, PLAN_RUN_SCHEMA_ID, errors);
  requireEnum(
    run,
    'status',
    ['pending', 'validating', 'running', 'succeeded', 'failed', 'blocked', 'needsApproval', 'cancelled'],
    `${PLAN_RUN_SCHEMA_ID}.status`,
    errors
  );

  if (requiresValidatedPlanFields(run.status)) {
    requireNonEmptyString(run, 'planId', `${PLAN_RUN_SCHEMA_ID}.planId`, errors);
    requireNonEmptyString(run, 'planHash', `${PLAN_RUN_SCHEMA_ID}.planHash`, errors);
    validatePlanRunStages(run.stages, errors);
  }

  if (run.tasks !== undefined) {
    validatePlanRunTasks(run.tasks, errors);
  }

  for (const property of ['currentStageId', 'currentTaskId', 'startedAt', 'finishedAt', 'blockReason']) {
    if (run[property] !== undefined && typeof run[property] !== 'string') {
      errors.push(`${PLAN_RUN_SCHEMA_ID}.${property} must be string`);
    }
  }

  return finish<PlanRun>(value, errors);
}

export function validateTraceEvent(value: unknown): SchemaValidationResult<TraceEvent> {
  const errors: string[] = [];
  const event = expectRecord(value, TRACE_EVENT_SCHEMA_ID, errors);
  if (!event) {
    return invalid(errors);
  }

  validateSchemaVersion(event, TRACE_EVENT_SCHEMA_ID, errors);
  requireNonEmptyString(event, 'id', `${TRACE_EVENT_SCHEMA_ID}.id`, errors);
  requireNonEmptyString(event, 'type', `${TRACE_EVENT_SCHEMA_ID}.type`, errors);
  requireNonEmptyString(event, 'timestamp', `${TRACE_EVENT_SCHEMA_ID}.timestamp`, errors);
  if (event.parentIds !== undefined) {
    requireStringArray(event, 'parentIds', `${TRACE_EVENT_SCHEMA_ID}.parentIds`, errors, true);
  }
  if (event.content !== undefined) {
    errors.push(`${TRACE_EVENT_SCHEMA_ID}.content is not allowed; store references and hashes instead`);
  }
  if (event.body !== undefined) {
    errors.push(`${TRACE_EVENT_SCHEMA_ID}.body is not allowed; store references and hashes instead`);
  }
  if (event.refs !== undefined && !isRecord(event.refs)) {
    errors.push(`${TRACE_EVENT_SCHEMA_ID}.refs must be object`);
  }

  return finish<TraceEvent>(value, errors);
}

function validatePlanStages(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${MASTER_PLAN_SCHEMA_ID}.stages must be a non-empty array`);
    return;
  }

  const stageIds = new Set<string>();
  value.forEach((stage, index) => {
    const path = `${MASTER_PLAN_SCHEMA_ID}.stages[${index}]`;
    if (!isRecord(stage)) {
      errors.push(`${path} must be object`);
      return;
    }
    const stageId = requireNonEmptyString(stage, 'id', `${path}.id`, errors);
    if (stageId && stageIds.has(stageId)) {
      errors.push(`${path}.id duplicates stage id ${stageId}`);
    }
    if (stageId) {
      stageIds.add(stageId);
    }
    if (stage.name !== undefined && typeof stage.name !== 'string') {
      errors.push(`${path}.name must be string`);
    }
    validatePlanTasks(stage.tasks, path, errors);
  });
}

function validatePlanTasks(value: unknown, stagePath: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${stagePath}.tasks must be a non-empty array`);
    return;
  }

  const taskIds = new Set<string>();
  value.forEach((task, index) => {
    const path = `${stagePath}.tasks[${index}]`;
    if (!isRecord(task)) {
      errors.push(`${path} must be object`);
      return;
    }
    const taskId = requireNonEmptyString(task, 'id', `${path}.id`, errors);
    if (taskId && taskIds.has(taskId)) {
      errors.push(`${path}.id duplicates task id ${taskId}`);
    }
    if (taskId) {
      taskIds.add(taskId);
    }
    requireEnum(task, 'type', ['agent'], `${path}.type`, errors);
    requireNonEmptyString(task, 'goal', `${path}.goal`, errors);
    requireStringArray(task, 'successCriteria', `${path}.successCriteria`, errors);
    requireStringArray(task, 'evidenceRequired', `${path}.evidenceRequired`, errors);
    validateConfidencePolicy(task.confidencePolicy, `${path}.confidencePolicy`, errors);
    validateExpectedOutputs(task.expectedOutputs, `${path}.expectedOutputs`, errors);
    if (task.nonGoals !== undefined) {
      requireStringArray(task, 'nonGoals', `${path}.nonGoals`, errors);
    }
    if (task.tools !== undefined) {
      requireStringArray(task, 'tools', `${path}.tools`, errors, true);
    }
    if (task.scope !== undefined && !isRecord(task.scope)) {
      errors.push(`${path}.scope must be object`);
    }
    if (task.role !== undefined) {
      requireNonEmptyString(task, 'role', `${path}.role`, errors);
    }
    if (task.taskBoundary !== undefined) {
      validateTaskBoundary(task.taskBoundary, `${path}.taskBoundary`, errors);
    }
    if (task.dependsOn !== undefined) {
      requireStringArray(task, 'dependsOn', `${path}.dependsOn`, errors, true);
    }
    if (task.inputArtifacts !== undefined) {
      requireStringArray(task, 'inputArtifacts', `${path}.inputArtifacts`, errors, true);
    }
    if (task.outputPurpose !== undefined) {
      requireNonEmptyString(task, 'outputPurpose', `${path}.outputPurpose`, errors);
    }
  });
}

function validateTaskBoundary(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  if (value.role !== undefined) {
    requireNonEmptyString(value, 'role', `${path}.role`, errors);
  }
  const maxAgentInvocations = value.maxAgentInvocations;
  if (
    maxAgentInvocations !== undefined
    && (typeof maxAgentInvocations !== 'number' || !Number.isInteger(maxAgentInvocations) || maxAgentInvocations < 1)
  ) {
    errors.push(`${path}.maxAgentInvocations must be a positive integer`);
  }
  if (value.description !== undefined) {
    requireNonEmptyString(value, 'description', `${path}.description`, errors);
  }
}

function validateConfidencePolicy(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  if (typeof value.requireAllCriteria !== 'boolean') {
    errors.push(`${path}.requireAllCriteria must be boolean`);
  }
  if (typeof value.requireAllEvidence !== 'boolean') {
    errors.push(`${path}.requireAllEvidence must be boolean`);
  }
  requireEnum(value, 'onFailure', ['block', 'retry', 'needsApproval'], `${path}.onFailure`, errors);
}

function validateExpectedOutputs(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((output, index) => {
    const outputPath = `${path}[${index}]`;
    if (!isRecord(output)) {
      errors.push(`${outputPath} must be object`);
      return;
    }
    for (const key of Object.keys(output)) {
      if (!EXPECTED_OUTPUT_KEYS.has(key)) {
        errors.push(`${outputPath}.${key} is not allowed`);
      }
    }
    requireNonEmptyString(output, 'path', `${outputPath}.path`, errors);
    requireEnum(output, 'format', ['json', 'markdown', 'text'], `${outputPath}.format`, errors);
    if (output.required !== undefined && typeof output.required !== 'boolean') {
      errors.push(`${outputPath}.required must be boolean`);
    }
    if (output.schema !== undefined && (typeof output.schema !== 'string' || output.schema.trim().length === 0)) {
      errors.push(`${outputPath}.schema must be a non-empty string`);
    }
  });
}

function validateCriteriaResults(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((result, index) => {
    const resultPath = `${path}[${index}]`;
    if (!isRecord(result)) {
      errors.push(`${resultPath} must be object`);
      return;
    }
    requireNonEmptyString(result, 'criterion', `${resultPath}.criterion`, errors);
    if (typeof result.passed !== 'boolean') {
      errors.push(`${resultPath}.passed must be boolean`);
    }
    requireStringArray(result, 'evidence', `${resultPath}.evidence`, errors, true);
  });
}

function validateToolEntries(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${TOOL_INVENTORY_SCHEMA_ID}.tools must be array`);
    return;
  }
  value.forEach((tool, index) => {
    const path = `${TOOL_INVENTORY_SCHEMA_ID}.tools[${index}]`;
    if (!isRecord(tool)) {
      errors.push(`${path} must be object`);
      return;
    }
    requireNonEmptyString(tool, 'id', `${path}.id`, errors);
    requireEnum(tool, 'source', ['skills', 'agents', 'commands', 'workflowPrimitives', 'runtimeActions', 'mcpTools', 'workflowPreferences'], `${path}.source`, errors);
    requireStringArray(tool, 'capabilities', `${path}.capabilities`, errors, true);
    for (const property of ['description', 'path', 'title', 'summary']) {
      if (tool[property] !== undefined && typeof tool[property] !== 'string') {
        errors.push(`${path}.${property} must be string`);
      }
    }
  });
}

function validatePlanWorkflowPreferences(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  requireStringArray(value, 'selectedPreferenceIds', `${path}.selectedPreferenceIds`, errors, true);
  requireStringArray(value, 'interpretedRequirements', `${path}.interpretedRequirements`, errors, true);
  if (value.conflicts !== undefined) {
    requireStringArray(value, 'conflicts', `${path}.conflicts`, errors, true);
  }
}

function validateWorkflowPreferenceEntry(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  requireNonEmptyString(value, 'id', `${path}.id`, errors);
  requireEnum(value, 'source', ['builtInDefault', 'global', 'project', 'runOverride'], `${path}.source`, errors);
  requireNonEmptyString(value, 'title', `${path}.title`, errors);
  requireNonEmptyString(value, 'summary', `${path}.summary`, errors);
  requireNonEmptyString(value, 'content', `${path}.content`, errors);
  requireNonEmptyString(value, 'contentSha256', `${path}.contentSha256`, errors);
  if (value.path !== undefined && typeof value.path !== 'string') {
    errors.push(`${path}.path must be string`);
  }
}

function validateWorkflowPreferenceSkippedEntry(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  requireNonEmptyString(value, 'path', `${path}.path`, errors);
  requireNonEmptyString(value, 'reason', `${path}.reason`, errors);
}

function validateMemoryProposalEntry(value: unknown, index: number, errors: string[]): void {
  const path = `${MEMORY_PROPOSAL_SCHEMA_ID}.proposals[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }
  requireNonEmptyString(value, 'key', `${path}.key`, errors);
  requireNonEmptyString(value, 'sourceArtifact', `${path}.sourceArtifact`, errors);
  if (value.value === undefined) {
    errors.push(`${path}.value is required`);
  }
  if (typeof value.safeToRetain !== 'boolean') {
    errors.push(`${path}.safeToRetain must be boolean`);
  }
  if (typeof value.mayContainSecrets !== 'boolean') {
    errors.push(`${path}.mayContainSecrets must be boolean`);
  }
}

function validateValidationErrors(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return;
  }
  value.forEach((error, index) => {
    const errorPath = `${path}[${index}]`;
    if (!isRecord(error)) {
      errors.push(`${errorPath} must be object`);
      return;
    }
    requireNonEmptyString(error, 'code', `${errorPath}.code`, errors);
    requireNonEmptyString(error, 'message', `${errorPath}.message`, errors);
    if (error.path !== undefined && typeof error.path !== 'string') {
      errors.push(`${errorPath}.path must be string`);
    }
  });
}

function validatePlanRunStages(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${PLAN_RUN_SCHEMA_ID}.stages must be array after plan validation`);
    return;
  }
  value.forEach((stage, index) => {
    const path = `${PLAN_RUN_SCHEMA_ID}.stages[${index}]`;
    if (!isRecord(stage)) {
      errors.push(`${path} must be object`);
      return;
    }
    requireNonEmptyString(stage, 'stageRunId', `${path}.stageRunId`, errors);
    requireNonEmptyString(stage, 'stageId', `${path}.stageId`, errors);
    requireEnum(stage, 'status', ['pending', 'running', 'succeeded', 'failed', 'blocked', 'skipped'], `${path}.status`, errors);
  });
}

function validatePlanRunTasks(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${PLAN_RUN_SCHEMA_ID}.tasks must be array`);
    return;
  }
  value.forEach((task, index) => {
    const path = `${PLAN_RUN_SCHEMA_ID}.tasks[${index}]`;
    if (!isRecord(task)) {
      errors.push(`${path} must be object`);
      return;
    }
    requireNonEmptyString(task, 'taskRunId', `${path}.taskRunId`, errors);
    requireNonEmptyString(task, 'taskId', `${path}.taskId`, errors);
    requireNonEmptyString(task, 'stageId', `${path}.stageId`, errors);
    requireEnum(task, 'status', ['pending', 'running', 'succeeded', 'failed', 'blocked', 'needsApproval', 'cancelled'], `${path}.status`, errors);
  });
}

function requiresValidatedPlanFields(status: unknown): boolean {
  return status === 'running' || status === 'succeeded' || status === 'needsApproval' || status === 'cancelled';
}

function validateSchemaVersion(value: Record<string, unknown>, schemaId: string, errors: string[]): void {
  if (value.schemaVersion !== PLAN_SCHEMA_VERSION) {
    errors.push(`SCHEMA_VERSION_MISMATCH: ${schemaId}.schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
  }
}

function expectRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return undefined;
  }
  return value;
}

function requireNonEmptyString(value: Record<string, unknown>, property: string, path: string, errors: string[]): string | undefined {
  const propertyValue = value[property];
  if (typeof propertyValue !== 'string' || propertyValue.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return propertyValue;
}

function requireStringArray(
  value: Record<string, unknown>,
  property: string,
  path: string,
  errors: string[],
  allowEmpty = false
): void {
  const propertyValue = value[property];
  if (!Array.isArray(propertyValue) || (!allowEmpty && propertyValue.length === 0)) {
    errors.push(`${path} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
    return;
  }
  propertyValue.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    }
  });
}

function requireEnum(
  value: Record<string, unknown>,
  property: string,
  allowed: string[],
  path: string,
  errors: string[]
): void {
  const propertyValue = value[property];
  if (typeof propertyValue !== 'string' || !allowed.includes(propertyValue)) {
    errors.push(`${path} must be one of: ${allowed.join(', ')}`);
  }
}

function finish<T>(value: unknown, errors: string[]): SchemaValidationResult<T> {
  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? value as T : undefined,
    errors
  };
}

function invalid<T>(errors: string[]): SchemaValidationResult<T> {
  return {
    valid: false,
    errors
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
