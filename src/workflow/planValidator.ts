import * as path from 'path';
import type { ArtifactSpec } from '../types';
import {
  MasterPlan,
  PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID,
  PLAN_SCHEMA_VERSION,
  PlanTask,
  PlanValidationArtifact,
  PlanValidationError,
  ToolInventory,
  ToolInventoryEntry,
  validateMasterPlan
} from './planSchemas';
import { validateArtifactPath } from './workflowValidation';
import type { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export const PLAN_VALIDATION_ERROR_CODES = {
  JSON_PARSE_ERROR: 'JSON_PARSE_ERROR',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',
  HIGH_RISK_REQUIRES_APPROVAL: 'HIGH_RISK_REQUIRES_APPROVAL',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_CAPABILITY_NOT_ALLOWED: 'TOOL_CAPABILITY_NOT_ALLOWED',
  DUPLICATE_TOOL_ID: 'DUPLICATE_TOOL_ID',
  DUPLICATE_OUTPUT_PATH: 'DUPLICATE_OUTPUT_PATH',
  UNSAFE_OUTPUT_PATH: 'UNSAFE_OUTPUT_PATH',
  NON_CANONICAL_AMENDMENT_PROPOSAL: 'NON_CANONICAL_AMENDMENT_PROPOSAL',
  UNKNOWN_OUTPUT_SCHEMA: 'UNKNOWN_OUTPUT_SCHEMA',
  AMBIGUOUS_TASK_GOAL: 'AMBIGUOUS_TASK_GOAL',
  MULTIPLE_TASK_ROLES: 'MULTIPLE_TASK_ROLES',
  MULTI_AGENT_TASK: 'MULTI_AGENT_TASK',
  SIDE_EFFECT_REQUIRES_DEPENDENCY: 'SIDE_EFFECT_REQUIRES_DEPENDENCY'
} as const;

export interface PlanValidationContext {
  toolInventory: ToolInventory;
  allowedCapabilities?: string[];
  schemaRegistry?: WorkflowSchemaRegistry;
}

export interface PlanValidatorResult {
  valid: boolean;
  plan?: MasterPlan;
  artifact: PlanValidationArtifact;
}

export class PlanValidator {
  validateJsonContent(content: string, context: PlanValidationContext): PlanValidatorResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      return this.fromErrors([{
        code: PLAN_VALIDATION_ERROR_CODES.JSON_PARSE_ERROR,
        message: error instanceof Error ? error.message : String(error)
      }]);
    }

    return this.validate(parsed, context);
  }

  validate(value: unknown, context: PlanValidationContext): PlanValidatorResult {
    const schemaResult = validateMasterPlan(value);
    if (!schemaResult.valid || !schemaResult.value) {
      return this.fromErrors(schemaResult.errors.map(message => ({
        code: PLAN_VALIDATION_ERROR_CODES.SCHEMA_INVALID,
        message
      })));
    }

    const plan = schemaResult.value;
    const errors: PlanValidationError[] = [
      ...this.validateInventory(context.toolInventory),
      ...this.validateAllowedCapabilities(plan, context),
      ...this.validateRiskPolicy(plan),
      ...this.validateTaskPolicies(plan, context)
    ];

    return {
      valid: errors.length === 0,
      plan: errors.length === 0 ? plan : undefined,
      artifact: {
        schemaVersion: PLAN_SCHEMA_VERSION,
        valid: errors.length === 0,
        errors
      }
    };
  }

  private validateInventory(inventory: ToolInventory): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    const seen = new Set<string>();

    for (const tool of inventory.tools) {
      if (seen.has(tool.id)) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.DUPLICATE_TOOL_ID,
          message: `Tool inventory contains duplicate tool id: ${tool.id}`,
          path: 'toolInventory.tools'
        });
      }
      seen.add(tool.id);
    }

    return errors;
  }

  private validateAllowedCapabilities(plan: MasterPlan, context: PlanValidationContext): PlanValidationError[] {
    if (!context.allowedCapabilities) {
      return [];
    }

    const allowed = new Set(context.allowedCapabilities);
    return plan.allowedCapabilities
      .filter(capability => !allowed.has(capability))
      .map(capability => ({
        code: PLAN_VALIDATION_ERROR_CODES.UNKNOWN_CAPABILITY,
        message: `Plan references capability that is not allowed by the runtime: ${capability}`,
        path: 'allowedCapabilities'
      }));
  }

  private validateRiskPolicy(plan: MasterPlan): PlanValidationError[] {
    if (plan.riskLevel !== 'high' || plan.requiresApproval === true) {
      return [];
    }

    return [{
      code: PLAN_VALIDATION_ERROR_CODES.HIGH_RISK_REQUIRES_APPROVAL,
      message: 'High-risk plans require requiresApproval: true before execution',
      path: 'requiresApproval'
    }];
  }

  private validateTaskPolicies(plan: MasterPlan, context: PlanValidationContext): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    const inventoryById = new Map(context.toolInventory.tools.map(tool => [tool.id, tool]));
    const outputPaths = new Set<string>();

    plan.stages.forEach((stage, stageIndex) => {
      stage.tasks.forEach((task, taskIndex) => {
        const taskPath = `stages[${stageIndex}].tasks[${taskIndex}]`;
        errors.push(...this.validateTaskBoundary(task, taskPath));
        errors.push(...this.validateTaskTools(task, taskPath, plan, inventoryById));
        errors.push(...this.validateExpectedOutputs(task.expectedOutputs, taskPath, stage.id, task.id, context.schemaRegistry, outputPaths));
      });
    });

    return errors;
  }

  private validateTaskBoundary(task: PlanTask, taskPath: string): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    const trimmedGoal = task.goal.trim();

    if (trimmedGoal.split(/\s+/).length < 2 || /^(do it|handle it|fix it|make it work)$/i.test(trimmedGoal)) {
      errors.push({
        code: PLAN_VALIDATION_ERROR_CODES.AMBIGUOUS_TASK_GOAL,
        message: `Task goal is too ambiguous to audit as one agent invocation: ${task.goal}`,
        path: `${taskPath}.goal`
      });
    }

    const declaredRoles = [
      ...(task.role ? [{ value: task.role, path: `${taskPath}.role` }] : []),
      ...(task.taskBoundary?.role ? [{ value: task.taskBoundary.role, path: `${taskPath}.taskBoundary.role` }] : [])
    ];
    const distinctRoles = new Set(declaredRoles.map(role => this.normalizeRole(role.value)));
    if (
      declaredRoles.some(role => this.looksLikeMultipleRoles(role.value))
      || distinctRoles.size > 1
    ) {
      errors.push({
        code: PLAN_VALIDATION_ERROR_CODES.MULTIPLE_TASK_ROLES,
        message: 'Task declares multiple roles; split producer, verifier, synthesizer, and side-effect work into separate tasks',
        path: declaredRoles[0]?.path ?? taskPath
      });
    }

    if ((task.taskBoundary?.maxAgentInvocations ?? 1) > 1 || this.countAgentToolDeclarations(task) > 1) {
      errors.push({
        code: PLAN_VALIDATION_ERROR_CODES.MULTI_AGENT_TASK,
        message: 'Task would trigger more than one agent invocation; split it into separate one-agent tasks',
        path: task.taskBoundary?.maxAgentInvocations ? `${taskPath}.taskBoundary.maxAgentInvocations` : `${taskPath}.tools`
      });
    }

    if (
      this.isSideEffectTask(task)
      && ((task.dependsOn?.length ?? 0) === 0 || (task.inputArtifacts?.length ?? 0) === 0)
    ) {
      errors.push({
        code: PLAN_VALIDATION_ERROR_CODES.SIDE_EFFECT_REQUIRES_DEPENDENCY,
        message: 'Side-effect tasks must declare dependsOn and inputArtifacts from prior validation evidence',
        path: task.outputPurpose === 'sideEffect' ? `${taskPath}.outputPurpose` : `${taskPath}.goal`
      });
    }

    return errors;
  }

  private looksLikeMultipleRoles(role: string): boolean {
    return /[,/&+]|\band\b/i.test(role);
  }

  private normalizeRole(role: string): string {
    return role.trim().toLowerCase();
  }

  private countAgentToolDeclarations(task: PlanTask): number {
    return (task.tools ?? []).filter(tool => tool === 'workflow.agent').length;
  }

  private isSideEffectTask(task: PlanTask): boolean {
    if (task.outputPurpose === 'sideEffect') {
      return true;
    }
    return /\b(post|publish|submit|send|comment|merge|deploy|write comments?)\b/i.test(task.goal);
  }

  private validateTaskTools(
    task: PlanTask,
    taskPath: string,
    plan: MasterPlan,
    inventoryById: Map<string, ToolInventoryEntry>
  ): PlanValidationError[] {
    const errors: PlanValidationError[] = [];
    const allowedCapabilities = new Set(plan.allowedCapabilities);

    for (const toolId of task.tools ?? []) {
      const tool = inventoryById.get(toolId);
      if (!tool) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.UNKNOWN_TOOL,
          message: `Task references unknown tool: ${toolId}`,
          path: `${taskPath}.tools`
        });
        continue;
      }

      const disallowedCapabilities = tool.capabilities.filter(capability => !allowedCapabilities.has(capability));
      if (disallowedCapabilities.length > 0) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.TOOL_CAPABILITY_NOT_ALLOWED,
          message: `Tool ${toolId} requires capabilities not allowed by the plan: ${disallowedCapabilities.join(', ')}`,
          path: `${taskPath}.tools`
        });
      }
    }

    return errors;
  }

  private validateExpectedOutputs(
    expectedOutputs: ArtifactSpec[],
    taskPath: string,
    stageId: string,
    taskId: string,
    schemaRegistry: WorkflowSchemaRegistry | undefined,
    outputPaths: Set<string>
  ): PlanValidationError[] {
    const errors: PlanValidationError[] = [];

    expectedOutputs.forEach((output, outputIndex) => {
      const outputPath = `${taskPath}.expectedOutputs[${outputIndex}]`;
      const artifactPathErrors = validateArtifactPath(output.path, outputPath);
      for (const error of artifactPathErrors) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.UNSAFE_OUTPUT_PATH,
          message: error,
          path: outputPath
        });
      }

      const normalizedPath = path.normalize(output.path);
      const taskArtifactPrefix = path.normalize(`tasks/${stageId}/${taskId}/`);
      const canonicalAmendmentPath = path.normalize(`tasks/${stageId}/${taskId}/plan-amendment-proposal.json`);
      if (artifactPathErrors.length === 0 && !normalizedPath.startsWith(taskArtifactPrefix)) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.UNSAFE_OUTPUT_PATH,
          message: `Expected output path must stay under tasks/${stageId}/${taskId}/: ${output.path}`,
          path: outputPath
        });
      }
      if (output.schema === PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID && normalizedPath !== canonicalAmendmentPath) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.NON_CANONICAL_AMENDMENT_PROPOSAL,
          message: `Plan amendment proposals must use ${canonicalAmendmentPath}`,
          path: `${outputPath}.path`
        });
      }
      if (outputPaths.has(normalizedPath)) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.DUPLICATE_OUTPUT_PATH,
          message: `Expected output path is declared more than once: ${output.path}`,
          path: outputPath
        });
      }
      outputPaths.add(normalizedPath);

      if (output.schema && output.schema !== 'none' && schemaRegistry && !schemaRegistry.has(output.schema)) {
        errors.push({
          code: PLAN_VALIDATION_ERROR_CODES.UNKNOWN_OUTPUT_SCHEMA,
          message: `Expected output schema is not registered: ${output.schema}`,
          path: `${outputPath}.schema`
        });
      }
    });

    return errors;
  }

  private fromErrors(errors: PlanValidationError[]): PlanValidatorResult {
    return {
      valid: false,
      artifact: {
        schemaVersion: PLAN_SCHEMA_VERSION,
        valid: false,
        errors
      }
    };
  }
}
