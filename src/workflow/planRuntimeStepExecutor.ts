import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactSpec, StepStatus, WorkflowStep, WorkflowStepRun } from '../types';
import {
  AuditArtifact,
  MasterPlan,
  MEMORY_PROPOSAL_SCHEMA_ID,
  PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID,
  PLAN_SCHEMA_VERSION,
  PlanRun,
  PlanRunStage,
  PlanRunTask,
  PlanTask,
  PlanTaskStatus,
  PlanValidationArtifact,
  TOOL_USE_EVIDENCE_SCHEMA_ID,
  ToolInventory,
  ToolUseEvidenceArtifact
} from './planSchemas';
import { ConfidenceGate } from './confidenceGate';
import { OutputContractManager, OutputValidationResult } from './outputContractManager';
import { PlanValidator, PLAN_VALIDATION_ERROR_CODES } from './planValidator';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';
import {
  hashExistingFile,
  hashExistingOutputs,
  safeResolveRunPath,
  TaskProvenanceArtifact,
  TaskStatusArtifact,
  TaskValidationArtifact,
  taskRuntimePaths
} from './taskRuntimeArtifacts';
import { renderTemplate } from './variableResolver';
import type { WorkflowSchemaRegistry } from './workflowSchemaRegistry';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import { WorkflowMemoryStore } from './workflowMemoryStore';

interface PlanRuntimeStepInput {
  planArtifact?: string;
  toolInventoryArtifact?: string;
  allowedCapabilities?: string[];
}

interface ToolUseEvidenceValidation {
  path?: string;
  checkedArtifacts: string[];
  missingEvidence: string[];
  risks: string[];
}

export class PlanRuntimeStepExecutor implements WorkflowStepExecutor {
  readonly type = 'planRuntime' as const;

  constructor(
    private readonly schemaRegistry: WorkflowSchemaRegistry,
    private readonly planValidator = new PlanValidator(),
    private readonly confidenceGate = new ConfidenceGate()
  ) {}

  async execute(step: WorkflowStep, stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    if (!step.output) {
      return {
        status: 'failed',
        error: `planRuntime step ${step.id} requires an output artifact`
      };
    }

    const input = step.input as PlanRuntimeStepInput | undefined;
    if (!input?.planArtifact || !input.toolInventoryArtifact) {
      return {
        status: 'failed',
        error: `planRuntime step ${step.id} requires input.planArtifact and input.toolInventoryArtifact`
      };
    }

    const traceStore = new TraceStore(context.run.runDir);
    const memoryStore = new WorkflowMemoryStore(context.run.runDir);
    const outputManager = new OutputContractManager(context.run.runDir, this.schemaRegistry);
    stepRun.expectedArtifact = context.artifactStore.resolveArtifactPath(step.output.path, context.variables);
    const artifactInputs = this.resolveInputArtifacts({
      planArtifact: input.planArtifact,
      toolInventoryArtifact: input.toolInventoryArtifact
    }, context);
    if (!artifactInputs.ok) {
      return {
        status: 'failed',
        error: artifactInputs.error
      };
    }

    let planRun: PlanRun = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      status: 'validating',
      startedAt: new Date().toISOString()
    };
    this.writePlanRun(step.output, planRun, context);
    traceStore.append('planRuntime.started', {
      status: 'validating',
      planArtifact: artifactInputs.planArtifact,
      toolInventoryArtifact: artifactInputs.toolInventoryArtifact
    });

    const planContent = context.artifactStore.readText(artifactInputs.planArtifact, context.variables);
    if (planContent === undefined) {
      return this.blockBeforePlan(step.output, planRun, context, traceStore, {
        schemaVersion: PLAN_SCHEMA_VERSION,
        valid: false,
        errors: [{
          code: PLAN_VALIDATION_ERROR_CODES.JSON_PARSE_ERROR,
          message: `Could not read plan artifact: ${artifactInputs.planArtifact}`
        }]
      });
    }

    const inventoryResult = this.readToolInventory(artifactInputs.toolInventoryArtifact, context);
    if (!inventoryResult.ok) {
      return this.blockBeforePlan(step.output, planRun, context, traceStore, inventoryResult.validation);
    }

    const validation = this.planValidator.validateJsonContent(planContent, {
      toolInventory: inventoryResult.inventory,
      allowedCapabilities: input.allowedCapabilities,
      schemaRegistry: this.schemaRegistry
    });
    context.artifactStore.writeJson('plan/plan-validation.json', validation.artifact, context.variables);
    traceStore.appendTyped(TRACE_EVENTS.PLAN_VALIDATED, {
      status: validation.valid ? 'passed' : 'failed',
      artifacts: [{ path: 'plan/plan-validation.json' }]
    });

    if (!validation.valid || !validation.plan) {
      return this.blockBeforePlan(step.output, planRun, context, traceStore, validation.artifact);
    }

    const plan = validation.plan;
    const planHash = this.hash(planContent);
    planRun = this.initializeValidatedPlanRun(plan, planHash, planRun.startedAt);
    if (plan.riskLevel === 'high' && plan.requiresApproval === true) {
      return this.blockForApproval(step.output, stepRun.expectedArtifact, planRun, context, traceStore);
    }
    if (context.token.isCancellationRequested) {
      return this.cancelPlanRun(step.output, stepRun.expectedArtifact, planRun, context, traceStore, 'Workflow cancelled before plan execution');
    }

    memoryStore.seedRunMemory({
      workflowId: context.workflow.id,
      workflowName: context.workflow.name,
      runId: context.run.id,
      runDir: context.run.runDir
    });
    memoryStore.writePlanMemory(plan);

    const childRuns: WorkflowStepRun[] = [];
    for (const stage of plan.stages) {
      if (context.token.isCancellationRequested) {
        return this.cancelPlanRun(step.output, stepRun.expectedArtifact, planRun, context, traceStore, 'Workflow cancelled before stage execution');
      }

      this.updateStage(planRun, stage.id, 'running');
      planRun.currentStageId = stage.id;
      this.writePlanRun(step.output, planRun, context);
      traceStore.append('stage.started', { stageId: stage.id });

      for (const task of stage.tasks) {
        if (context.token.isCancellationRequested) {
          return this.cancelPlanRun(step.output, stepRun.expectedArtifact, planRun, context, traceStore, 'Workflow cancelled before task execution');
        }

        const taskResult = await this.executeTask({
          planRun,
          stageId: stage.id,
          task,
          toolInventory: inventoryResult.inventory,
          outputManager,
          memoryStore,
          context,
          traceStore
        });
        childRuns.push(...taskResult.childRuns);
        this.writePlanRun(step.output, planRun, context);

        if (taskResult.terminalResult) {
          traceStore.rebuildIndexes();
          return {
            ...taskResult.terminalResult,
            outputArtifact: stepRun.expectedArtifact,
            childRuns,
            output: planRun
          };
        }
      }

      this.updateStage(planRun, stage.id, 'succeeded');
      traceStore.appendTyped(TRACE_EVENTS.STAGE_ADVANCED, { stageId: stage.id, status: 'succeeded' });
      traceStore.append('stage.completed', { stageId: stage.id, status: 'succeeded' });
    }

    planRun.status = 'succeeded';
    planRun.currentStageId = undefined;
    planRun.currentTaskId = undefined;
    planRun.finishedAt = new Date().toISOString();
    this.writePlanRun(step.output, planRun, context);
    traceStore.append('planRuntime.completed', { status: 'succeeded' });
    traceStore.rebuildIndexes();

    return {
      status: 'succeeded',
      outputArtifact: stepRun.expectedArtifact,
      childRuns,
      output: planRun
    };
  }

  private async executeTask(options: {
    planRun: PlanRun;
    stageId: string;
    task: PlanTask;
    toolInventory: ToolInventory;
    outputManager: OutputContractManager;
    memoryStore: WorkflowMemoryStore;
    context: WorkflowExecutionContext;
    traceStore: TraceStore;
  }): Promise<{ childRuns: WorkflowStepRun[]; terminalResult?: StepExecutionResult }> {
    const { planRun, stageId, task, toolInventory, outputManager, memoryStore, context, traceStore } = options;
    const paths = taskRuntimePaths(stageId, task.id);
    const taskStartedAt = new Date().toISOString();
    this.updateTask(planRun, stageId, task.id, 'running');
    planRun.currentStageId = stageId;
    planRun.currentTaskId = task.id;
    traceStore.append('task.started', { stageId, taskId: task.id });

    const selectedMcpToolIds = this.selectedMcpToolIds(task, toolInventory);
    const mcpEvidencePath = selectedMcpToolIds.length > 0 ? this.toolUseEvidencePath(stageId, task.id) : undefined;
    const inputContext = memoryStore.createInputContext(stageId, task, toolInventory, {
      planMemoryKeys: ['objective', 'riskLevel', 'allowedCapabilities']
    });
    traceStore.appendTyped(TRACE_EVENTS.MEMORY_CONTEXT_CREATED, {
      stageId,
      taskId: task.id,
      artifacts: [{ path: paths.inputContext }]
    });
    if ((task.tools ?? []).length > 0) {
      traceStore.appendTyped(TRACE_EVENTS.TOOL_SELECTED, {
        stageId,
        taskId: task.id,
        tools: task.tools ?? []
      });
    }
    const prompt = this.buildTaskPrompt(task, inputContext.path, outputManager, context, selectedMcpToolIds, mcpEvidencePath);
    context.artifactStore.writeText(paths.taskPrompt, prompt, context.variables);
    const planHashBeforeTask = hashExistingFile(context.run.runDir, 'plan/master-plan.json');
    const childStep = this.createAgentTaskStep(stageId, task, prompt, paths);
    const child = await context.executeChildStep(childStep, `planRuntime.${stageId}.${task.id}`, context.variables);

    if (child.result.status !== 'succeeded') {
      const status = this.planTaskStatusForStepStatus(child.result.status);
      this.updateTask(planRun, stageId, task.id, status);
      planRun.status = status === 'needsApproval' ? 'needsApproval' : status === 'blocked' ? 'blocked' : status === 'cancelled' ? 'cancelled' : 'failed';
      planRun.blockReason = child.result.blockedReason ?? child.result.error ?? `Task ${task.id} did not succeed`;
      planRun.finishedAt = new Date().toISOString();
      this.writeTaskStatus(paths.status, status, planRun.blockReason, context);
      this.writeTaskValidation(paths.validation, {
        valid: false,
        checkedArtifacts: [paths.status],
        errors: [{
          code: 'TASK_DID_NOT_SUCCEED',
          message: planRun.blockReason,
          path: paths.status
        }],
        missingEvidence: [],
        risks: []
      }, context);
      this.writeTaskProvenance({
        path: paths.provenance,
        stageId,
        task,
        taskStartedAt,
        selectedTools: task.tools ?? [],
        inputContextPath: paths.inputContext,
        memoryHash: inputContext.value.provenance.memoryHash,
        toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
        outputPaths: [paths.status, paths.validation],
        context
      });
      traceStore.appendTyped(TRACE_EVENTS.TASK_VALIDATED, {
        stageId,
        taskId: task.id,
        status,
        artifacts: [{ path: paths.validation }]
      });
      traceStore.appendTyped(TRACE_EVENTS.STAGE_BLOCKED, {
        stageId,
        reason: planRun.blockReason
      });
      traceStore.append('task.completed', {
        stageId,
        taskId: task.id,
        status,
        reason: planRun.blockReason
      });
      return {
        childRuns: [child.stepRun],
        terminalResult: {
          status: child.result.status,
          error: child.result.error,
          blockedReason: child.result.blockedReason ?? planRun.blockReason
        }
      };
    }

    const planHashAfterChild = hashExistingFile(context.run.runDir, 'plan/master-plan.json');
    if (planHashBeforeTask && planHashAfterChild && planHashBeforeTask !== planHashAfterChild) {
      const reason = 'Task modified the active master plan; plan amendments must be proposed, not applied';
      this.updateTask(planRun, stageId, task.id, 'blocked');
      planRun.status = 'blocked';
      planRun.blockReason = reason;
      planRun.finishedAt = new Date().toISOString();
      this.writeTaskStatus(paths.status, 'blocked', reason, context);
      this.writeTaskValidation(paths.validation, {
        valid: false,
        checkedArtifacts: ['plan/master-plan.json'],
        errors: [{
          code: 'ACTIVE_PLAN_HASH_CHANGED',
          message: reason,
          path: 'plan/master-plan.json'
        }],
        missingEvidence: [],
        risks: []
      }, context);
      this.writeTaskProvenance({
        path: paths.provenance,
        stageId,
        task,
        taskStartedAt,
        selectedTools: task.tools ?? [],
        inputContextPath: paths.inputContext,
        memoryHash: inputContext.value.provenance.memoryHash,
        toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
        outputPaths: [paths.validation, paths.status, 'plan/master-plan.json'],
        context
      });
      traceStore.appendTyped(TRACE_EVENTS.PLAN_RUNTIME_BLOCKED, {
        reason,
        stageId,
        taskId: task.id,
        artifacts: [{ path: paths.validation }, { path: paths.status }]
      });
      traceStore.appendTyped(TRACE_EVENTS.STAGE_BLOCKED, { stageId, reason });
      return {
        childRuns: [child.stepRun],
        terminalResult: {
          status: 'blocked',
          blockedReason: reason
        }
      };
    }

    const nonCanonicalAmendmentPaths = this.findNonCanonicalAmendmentProposalPaths(context.run.runDir, paths.dir, paths.amendmentProposal);
    if (nonCanonicalAmendmentPaths.length > 0) {
      const reason = `Plan amendment proposals must be written only to ${paths.amendmentProposal}; found ${nonCanonicalAmendmentPaths.join(', ')}`;
      this.updateTask(planRun, stageId, task.id, 'blocked');
      planRun.status = 'blocked';
      planRun.blockReason = reason;
      planRun.finishedAt = new Date().toISOString();
      this.writeTaskStatus(paths.status, 'blocked', reason, context);
      this.writeTaskValidation(paths.validation, {
        valid: false,
        checkedArtifacts: nonCanonicalAmendmentPaths,
        errors: nonCanonicalAmendmentPaths.map(artifactPath => ({
          code: 'NON_CANONICAL_AMENDMENT_PROPOSAL',
          message: reason,
          path: artifactPath
        })),
        missingEvidence: [],
        risks: []
      }, context);
      this.writeTaskProvenance({
        path: paths.provenance,
        stageId,
        task,
        taskStartedAt,
        selectedTools: task.tools ?? [],
        inputContextPath: paths.inputContext,
        memoryHash: inputContext.value.provenance.memoryHash,
        toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
        outputPaths: [...nonCanonicalAmendmentPaths, paths.validation, paths.status],
        context
      });
      traceStore.appendTyped(TRACE_EVENTS.PLAN_RUNTIME_BLOCKED, {
        reason,
        stageId,
        taskId: task.id,
        artifacts: [{ path: paths.validation }, { path: paths.status }]
      });
      traceStore.appendTyped(TRACE_EVENTS.STAGE_BLOCKED, { stageId, reason });
      return {
        childRuns: [child.stepRun],
        terminalResult: {
          status: 'blocked',
          blockedReason: reason
        }
      };
    }

    const outputValidation = outputManager.validateDeclaredOutputs(task.expectedOutputs, context.variables, {
      taskArtifactDir: paths.dir,
      allowlist: [
        paths.inputContext,
        paths.taskPrompt,
        paths.prompt,
        paths.validation,
        paths.provenance,
        paths.memoryProposals,
        paths.amendmentProposal,
        ...(mcpEvidencePath ? [mcpEvidencePath] : [])
      ]
    });
    const toolUseEvidenceValidation = this.validateToolUseEvidence(context.run.runDir, selectedMcpToolIds, mcpEvidencePath);
    const memoryProposalValidation = this.validateOptionalJsonArtifact(paths.memoryProposals, MEMORY_PROPOSAL_SCHEMA_ID, context);
    if (memoryProposalValidation.exists) {
      traceStore.appendTyped(TRACE_EVENTS.MEMORY_PROPOSED, {
        stageId,
        taskId: task.id,
        artifacts: [{ path: paths.memoryProposals }]
      });
    }
    const taskAuthoredAuditError = this.validateNoTaskAuthoredAudit(stageId, task.id, context.run.runDir);
    const validationErrors = [
      ...outputValidation.errors,
      ...memoryProposalValidation.errors,
      ...(taskAuthoredAuditError ? [taskAuthoredAuditError] : [])
    ];
    const mergedOutputValidation: OutputValidationResult = {
      valid: outputValidation.valid && validationErrors.length === 0,
      checkedArtifacts: outputValidation.checkedArtifacts,
      errors: validationErrors
    };
    const taskValidation = this.writeTaskValidation(paths.validation, {
      valid: validationErrors.length === 0 && toolUseEvidenceValidation.missingEvidence.length === 0 && toolUseEvidenceValidation.risks.length === 0,
      checkedArtifacts: [
        ...outputValidation.checkedArtifacts,
        ...toolUseEvidenceValidation.checkedArtifacts,
        ...(memoryProposalValidation.exists ? [paths.memoryProposals] : [])
      ],
      errors: validationErrors,
      missingEvidence: toolUseEvidenceValidation.missingEvidence,
      risks: toolUseEvidenceValidation.risks
    }, context);
    traceStore.appendTyped(TRACE_EVENTS.TASK_VALIDATED, {
      stageId,
      taskId: task.id,
      status: taskValidation.valid ? 'passed' : 'failed',
      artifacts: [{ path: paths.validation }]
    });
    const amendmentResult = this.validateAmendmentProposal(paths.amendmentProposal, context);
    if (amendmentResult.exists) {
      const planHashAfterTask = hashExistingFile(context.run.runDir, 'plan/master-plan.json');
      const reason = amendmentResult.valid
        ? 'Task proposed a plan amendment; workflow blocked for review'
        : `Task proposed an invalid plan amendment: ${amendmentResult.errors.join('; ')}`;
      this.updateTask(planRun, stageId, task.id, 'blocked');
      planRun.status = 'blocked';
      planRun.blockReason = planHashBeforeTask && planHashAfterTask && planHashBeforeTask !== planHashAfterTask
        ? `${reason}; active plan hash changed during task execution`
        : reason;
      planRun.finishedAt = new Date().toISOString();
      this.writeTaskStatus(paths.status, 'blocked', planRun.blockReason, context);
      this.writeTaskProvenance({
        path: paths.provenance,
        stageId,
        task,
        taskStartedAt,
        selectedTools: task.tools ?? [],
        inputContextPath: paths.inputContext,
        memoryHash: inputContext.value.provenance.memoryHash,
        toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
        outputPaths: [...task.expectedOutputs.map(output => output.path), paths.amendmentProposal, paths.validation, paths.status],
        context
      });
      traceStore.appendTyped(TRACE_EVENTS.PLAN_AMENDMENT_PROPOSED, {
        stageId,
        taskId: task.id,
        valid: amendmentResult.valid,
        artifacts: [{ path: paths.amendmentProposal }]
      });
      traceStore.appendTyped(TRACE_EVENTS.PLAN_RUNTIME_BLOCKED, {
        reason: planRun.blockReason,
        stageId,
        taskId: task.id,
        artifacts: [{ path: paths.amendmentProposal }, { path: paths.status }]
      });
      traceStore.appendTyped(TRACE_EVENTS.STAGE_BLOCKED, {
        stageId,
        reason: planRun.blockReason
      });
      return {
        childRuns: [child.stepRun],
        terminalResult: {
          status: 'blocked',
          blockedReason: planRun.blockReason
        }
      };
    }
    const audit = this.createDeterministicAudit(task, mergedOutputValidation, context.run.runDir, toolUseEvidenceValidation);
    const auditPath = `audits/${stageId}/${task.id}/audit.json`;
    context.artifactStore.writeJson(auditPath, audit, context.variables);
    traceStore.appendTyped(TRACE_EVENTS.AUDIT_COMPLETED, {
      stageId,
      taskId: task.id,
      status: audit.nextAction,
      risks: audit.risks,
      artifacts: [
        { path: auditPath },
        ...(toolUseEvidenceValidation.path ? [{ path: toolUseEvidenceValidation.path }] : [])
      ]
    });

    const gate = this.confidenceGate.evaluate(task, audit, mergedOutputValidation);
    if (!gate.passed) {
      this.updateTask(planRun, stageId, task.id, gate.status);
      planRun.status = gate.status === 'needsApproval' ? 'needsApproval' : gate.status === 'failed' ? 'failed' : 'blocked';
      planRun.blockReason = gate.reason;
      planRun.finishedAt = new Date().toISOString();
      this.writeTaskStatus(paths.status, gate.status, gate.reason ?? 'Task validation failed', context);
      this.writeTaskProvenance({
        path: paths.provenance,
        stageId,
        task,
        taskStartedAt,
        selectedTools: task.tools ?? [],
        inputContextPath: paths.inputContext,
        memoryHash: inputContext.value.provenance.memoryHash,
        toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
        outputPaths: [...task.expectedOutputs.map(output => output.path), paths.validation, auditPath, paths.status],
        context
      });
      traceStore.append('confidence.failed', {
        stageId,
        taskId: task.id,
        status: gate.status,
        reason: gate.reason,
        risks: gate.risks
      });
      traceStore.appendTyped(TRACE_EVENTS.STAGE_BLOCKED, {
        stageId,
        reason: gate.reason ?? 'Task validation failed'
      });
      return {
        childRuns: [child.stepRun],
        terminalResult: {
          status: gate.status === 'needsApproval' ? 'blocked' : gate.status,
          error: gate.status === 'failed' ? gate.reason : undefined,
          blockedReason: gate.status !== 'failed' ? gate.reason : undefined
        }
      };
    }

    this.updateTask(planRun, stageId, task.id, 'succeeded');
    this.writeTaskProvenance({
      path: paths.provenance,
      stageId,
      task,
      taskStartedAt,
      selectedTools: task.tools ?? [],
      inputContextPath: paths.inputContext,
      memoryHash: inputContext.value.provenance.memoryHash,
      toolInventoryHash: inputContext.value.provenance.toolInventoryHash,
      outputPaths: [...task.expectedOutputs.map(output => output.path), paths.validation, auditPath],
      context
    });
    traceStore.appendTyped(TRACE_EVENTS.ARTIFACT_PRODUCED, {
      stageId,
      taskId: task.id,
      artifacts: task.expectedOutputs.map(output => ({ path: output.path }))
    });
    traceStore.append('task.completed', {
      stageId,
      taskId: task.id,
      status: 'succeeded'
    });
    return {
      childRuns: [child.stepRun]
    };
  }

  private blockBeforePlan(
    output: ArtifactSpec,
    planRun: PlanRun,
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    validation: PlanValidationArtifact
  ): StepExecutionResult {
    context.artifactStore.writeJson('plan/plan-validation.json', validation, context.variables);
    planRun.status = 'blocked';
    planRun.blockReason = validation.errors.map(error => error.message).join('; ') || 'Plan validation failed';
    planRun.finishedAt = new Date().toISOString();
    this.writePlanRun(output, planRun, context);
    traceStore.append('planRuntime.blocked', {
      reason: planRun.blockReason,
      artifacts: [{ path: 'plan/plan-validation.json' }]
    });
    traceStore.rebuildIndexes();

    return {
      status: 'blocked',
      blockedReason: planRun.blockReason,
      outputArtifact: context.artifactStore.resolveArtifactPath(output.path, context.variables),
      output: planRun
    };
  }

  private blockForApproval(
    output: ArtifactSpec,
    outputArtifact: string | undefined,
    planRun: PlanRun,
    context: WorkflowExecutionContext,
    traceStore: TraceStore
  ): StepExecutionResult {
    planRun.status = 'needsApproval';
    planRun.blockReason = 'High-risk plan requires human approval before execution';
    planRun.finishedAt = new Date().toISOString();
    this.writePlanRun(output, planRun, context);
    traceStore.append('planRuntime.blocked', {
      status: 'needsApproval',
      reason: planRun.blockReason
    });
    traceStore.rebuildIndexes();

    return {
      status: 'blocked',
      blockedReason: planRun.blockReason,
      outputArtifact,
      output: planRun
    };
  }

  private cancelPlanRun(
    output: ArtifactSpec,
    outputArtifact: string | undefined,
    planRun: PlanRun,
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    reason: string
  ): StepExecutionResult {
    planRun.status = 'cancelled';
    planRun.blockReason = reason;
    planRun.currentStageId = undefined;
    planRun.currentTaskId = undefined;
    planRun.finishedAt = new Date().toISOString();
    this.writePlanRun(output, planRun, context);
    traceStore.append('planRuntime.cancelled', {
      status: 'cancelled',
      reason
    });
    traceStore.rebuildIndexes();

    return {
      status: 'cancelled',
      outputArtifact,
      output: planRun
    };
  }

  private resolveInputArtifacts(
    input: Required<Pick<PlanRuntimeStepInput, 'planArtifact' | 'toolInventoryArtifact'>>,
    context: WorkflowExecutionContext
  ): { ok: true; planArtifact: string; toolInventoryArtifact: string } | { ok: false; error: string } {
    try {
      return {
        ok: true,
        planArtifact: this.resolveRunRelativeArtifact(input.planArtifact, context),
        toolInventoryArtifact: this.resolveRunRelativeArtifact(input.toolInventoryArtifact, context)
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private resolveRunRelativeArtifact(artifactPathTemplate: string, context: WorkflowExecutionContext): string {
    const renderedPath = renderTemplate(artifactPathTemplate, context.variables);
    if (!path.isAbsolute(renderedPath)) {
      return renderedPath;
    }

    const relativePath = path.relative(context.run.runDir, renderedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`planRuntime artifact path must be inside runDir: ${renderedPath}`);
    }
    if (relativePath.length === 0) {
      throw new Error(`planRuntime artifact path must point to a file inside runDir: ${renderedPath}`);
    }

    return relativePath;
  }

  private readToolInventory(
    artifactPath: string,
    context: WorkflowExecutionContext
  ): { ok: true; inventory: ToolInventory } | { ok: false; validation: PlanValidationArtifact } {
    const inventory = context.artifactStore.readJson<ToolInventory>(artifactPath, context.variables);
    const validation = this.schemaRegistry.validate('tool-inventory@1', inventory);
    if (inventory !== undefined && validation.valid && validation.value) {
      return {
        ok: true,
        inventory: validation.value as ToolInventory
      };
    }

    return {
      ok: false,
      validation: {
        schemaVersion: PLAN_SCHEMA_VERSION,
        valid: false,
        errors: validation.errors.length > 0
          ? validation.errors.map(message => ({ code: PLAN_VALIDATION_ERROR_CODES.SCHEMA_INVALID, message }))
          : [{
              code: PLAN_VALIDATION_ERROR_CODES.SCHEMA_INVALID,
              message: `Could not read tool inventory artifact: ${artifactPath}`
            }]
      }
    };
  }

  private initializeValidatedPlanRun(plan: MasterPlan, planHash: string, startedAt: string | undefined): PlanRun {
    const stages: PlanRunStage[] = plan.stages.map(stage => ({
      stageRunId: stage.id,
      stageId: stage.id,
      status: 'pending'
    }));
    const tasks: PlanRunTask[] = plan.stages.flatMap(stage => stage.tasks.map(task => ({
      taskRunId: `${stage.id}.${task.id}`,
      taskId: task.id,
      stageId: stage.id,
      status: 'pending' as const
    })));

    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      status: 'running',
      planId: `plan-${planHash.slice(0, 12)}`,
      planHash,
      startedAt,
      stages,
      tasks
    };
  }

  private buildTaskPrompt(
    task: PlanTask,
    inputContextPath: string,
    outputManager: OutputContractManager,
    context: WorkflowExecutionContext,
    selectedMcpToolIds: string[] = [],
    mcpEvidencePath?: string
  ): string {
    const lines = [
      `Goal: ${task.goal}`,
      '',
      ...this.buildTaskBoundaryPrompt(task),
      'Success criteria:',
      ...task.successCriteria.map(criterion => `- ${criterion}`),
      '',
      'Required evidence:',
      ...task.evidenceRequired.map(evidence => `- ${evidence}`),
      '',
      `Input context JSON: ${inputContextPath}`,
      '',
      outputManager.buildPromptInstructions(task.expectedOutputs, context.variables)
    ];

    if (selectedMcpToolIds.length > 0 && mcpEvidencePath) {
      lines.push(
        '',
        'Advisory MCP tool evidence:',
        `The planner selected these MCP tools: ${selectedMcpToolIds.join(', ')}.`,
        'Use Cursor MCP tools yourself when they are relevant; the workflow runtime will not call them for you.',
        `If you use or attempt to use these MCP tools, write JSON evidence to ${path.join(context.run.runDir, mcpEvidencePath)} with this shape:`,
        JSON.stringify({
          schemaVersion: PLAN_SCHEMA_VERSION,
          claimedToolsUsed: selectedMcpToolIds,
          evidence: ['Briefly describe the MCP calls, inputs, result IDs, URLs, or observations used to support the output.'],
          notes: 'Optional caveats or failures.'
        }, null, 2)
      );
    }

    return lines.join('\n');
  }

  private buildTaskBoundaryPrompt(task: PlanTask): string[] {
    const lines: string[] = [];
    if (task.role) {
      lines.push(`Role: ${task.role}`);
    }
    if (task.outputPurpose) {
      lines.push(`Output purpose: ${task.outputPurpose}`);
    }
    if (task.taskBoundary) {
      lines.push('Task boundary:');
      if (task.taskBoundary.role) {
        lines.push(`- Role: ${task.taskBoundary.role}`);
      }
      if (task.taskBoundary.maxAgentInvocations) {
        lines.push(`- Max agent invocations: ${task.taskBoundary.maxAgentInvocations}`);
      }
      if (task.taskBoundary.description) {
        lines.push(`- ${task.taskBoundary.description}`);
      }
    }
    if (task.dependsOn && task.dependsOn.length > 0) {
      lines.push('Depends on:', ...task.dependsOn.map(taskId => `- ${taskId}`));
    }
    if (task.inputArtifacts && task.inputArtifacts.length > 0) {
      lines.push('Input artifacts:', ...task.inputArtifacts.map(artifact => `- ${artifact}`));
    }
    if (lines.length > 0) {
      lines.push('');
    }
    return lines;
  }

  private createAgentTaskStep(stageId: string, task: PlanTask, prompt: string, paths: ReturnType<typeof taskRuntimePaths>): WorkflowStep {
    return {
      id: `plan-${stageId}-${task.id}`,
      type: 'agent',
      input: {
        title: `${stageId}: ${task.id}`,
        prompt,
        freshChat: true,
        submitMode: 'worktree',
        promptArtifact: paths.prompt,
        statusArtifact: paths.status,
        stageId,
        taskId: task.id
      },
      output: task.expectedOutputs[0]
    };
  }

  private writeTaskValidation(
    artifactPath: string,
    artifact: Omit<TaskValidationArtifact, 'schemaVersion'>,
    context: WorkflowExecutionContext
  ): TaskValidationArtifact {
    const value: TaskValidationArtifact = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      ...artifact
    };
    context.artifactStore.writeJson(artifactPath, value, context.variables);
    return value;
  }

  private writeTaskStatus(
    artifactPath: string,
    status: PlanTaskStatus,
    reason: string,
    context: WorkflowExecutionContext
  ): void {
    if (status === 'pending' || status === 'running' || status === 'succeeded') {
      return;
    }
    const artifact: TaskStatusArtifact = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      status,
      reason
    };
    context.artifactStore.writeJson(artifactPath, artifact, context.variables);
  }

  private writeTaskProvenance(options: {
    path: string;
    stageId: string;
    task: PlanTask;
    taskStartedAt: string;
    selectedTools: string[];
    inputContextPath: string;
    memoryHash?: string;
    toolInventoryHash?: string;
    outputPaths: string[];
    context: WorkflowExecutionContext;
  }): TaskProvenanceArtifact {
    const artifact: TaskProvenanceArtifact = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      stageId: options.stageId,
      taskId: options.task.id,
      startedAt: options.taskStartedAt,
      finishedAt: new Date().toISOString(),
      promptSha256: hashExistingFile(options.context.run.runDir, taskRuntimePaths(options.stageId, options.task.id).prompt),
      inputContextSha256: hashExistingFile(options.context.run.runDir, options.inputContextPath),
      memoryHash: options.memoryHash,
      toolInventoryHash: options.toolInventoryHash,
      selectedTools: options.selectedTools,
      outputHashes: hashExistingOutputs(options.context.run.runDir, options.outputPaths)
    };
    options.context.artifactStore.writeJson(options.path, artifact, options.context.variables);
    return artifact;
  }

  private validateOptionalJsonArtifact(
    artifactPath: string,
    schemaId: string,
    context: WorkflowExecutionContext
  ): {
    exists: boolean;
    errors: Array<{ code: string; message: string; path?: string }>;
  } {
    const resolved = safeResolveRunPath(context.run.runDir, artifactPath);
    if (!resolved || !fs.existsSync(resolved)) {
      return { exists: false, errors: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } catch (error) {
      return {
        exists: true,
        errors: [{
          code: 'INVALID_RUNTIME_ARTIFACT_JSON',
          message: error instanceof Error ? error.message : String(error),
          path: artifactPath
        }]
      };
    }

    const validation = this.schemaRegistry.validate(schemaId, parsed);
    return {
      exists: true,
      errors: validation.valid ? [] : validation.errors.map(message => ({
        code: 'RUNTIME_ARTIFACT_SCHEMA_INVALID',
        message,
        path: artifactPath
      }))
    };
  }

  private validateAmendmentProposal(
    artifactPath: string,
    context: WorkflowExecutionContext
  ): { exists: boolean; valid: boolean; errors: string[] } {
    const validation = this.validateOptionalJsonArtifact(artifactPath, PLAN_AMENDMENT_PROPOSAL_SCHEMA_ID, context);
    return {
      exists: validation.exists,
      valid: validation.exists && validation.errors.length === 0,
      errors: validation.errors.map(error => error.message)
    };
  }

  private findNonCanonicalAmendmentProposalPaths(runDir: string, taskDir: string, canonicalPath: string): string[] {
    const resolvedTaskDir = safeResolveRunPath(runDir, taskDir);
    if (!resolvedTaskDir || !fs.existsSync(resolvedTaskDir)) {
      return [];
    }

    const canonical = path.normalize(canonicalPath);
    return this.listTaskFiles(runDir, resolvedTaskDir)
      .filter(artifactPath => path.basename(artifactPath) === 'plan-amendment-proposal.json')
      .filter(artifactPath => path.normalize(artifactPath) !== canonical)
      .sort();
  }

  private listTaskFiles(runDir: string, currentDir: string): string[] {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    return entries.flatMap(entry => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return this.listTaskFiles(runDir, fullPath);
      }
      if (!entry.isFile()) {
        return [];
      }
      const relativePath = path.relative(runDir, fullPath);
      return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? [] : [relativePath];
    });
  }

  private validateNoTaskAuthoredAudit(
    stageId: string,
    taskId: string,
    runDir: string
  ): { code: string; message: string; path?: string } | undefined {
    const auditPath = `audits/${stageId}/${taskId}/audit.json`;
    const resolved = safeResolveRunPath(runDir, auditPath);
    if (!resolved || !fs.existsSync(resolved)) {
      return undefined;
    }
    return {
      code: 'TASK_AUTHORED_AUDIT_ARTIFACT',
      message: `Task-authored audit artifacts are not allowed: ${auditPath}`,
      path: auditPath
    };
  }

  private createDeterministicAudit(
    task: PlanTask,
    outputValidation: OutputValidationResult,
    runDir: string,
    toolUseEvidenceValidation: ToolUseEvidenceValidation = { checkedArtifacts: [], missingEvidence: [], risks: [] }
  ): AuditArtifact {
    const missingEvidence = [
      ...task.evidenceRequired.filter(evidence => !this.relativeArtifactExists(runDir, evidence)),
      ...toolUseEvidenceValidation.missingEvidence
    ];
    const checkedArtifacts = [
      ...outputValidation.checkedArtifacts,
      ...toolUseEvidenceValidation.checkedArtifacts
    ];
    const passed = outputValidation.valid && missingEvidence.length === 0 && toolUseEvidenceValidation.risks.length === 0;
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      criteriaResults: task.successCriteria.map(criterion => ({
        criterion,
        passed,
        evidence: checkedArtifacts
      })),
      missingEvidence,
      risks: toolUseEvidenceValidation.risks,
      nextAction: passed ? 'advance' : task.confidencePolicy.onFailure === 'needsApproval' ? 'needsApproval' : 'block'
    };
  }

  private selectedMcpToolIds(task: PlanTask, toolInventory: ToolInventory): string[] {
    const declaredTools = new Set(task.tools ?? []);
    if (declaredTools.size === 0) {
      return [];
    }
    return toolInventory.tools
      .filter(tool => tool.source === 'mcpTools' && declaredTools.has(tool.id))
      .map(tool => tool.id);
  }

  private toolUseEvidencePath(stageId: string, taskId: string): string {
    return `tasks/${stageId}/${taskId}/tool-use-evidence.json`;
  }

  private validateToolUseEvidence(runDir: string, selectedMcpToolIds: string[], evidencePath: string | undefined): ToolUseEvidenceValidation {
    if (selectedMcpToolIds.length === 0 || !evidencePath) {
      return { checkedArtifacts: [], missingEvidence: [], risks: [] };
    }

    const resolvedPath = path.resolve(runDir, evidencePath);
    if (!this.relativeArtifactExists(runDir, evidencePath)) {
      return {
        path: evidencePath,
        checkedArtifacts: [evidencePath],
        missingEvidence: [`MCP tool-use evidence was not produced: ${evidencePath}`],
        risks: []
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    } catch (error) {
      return {
        path: evidencePath,
        checkedArtifacts: [evidencePath],
        missingEvidence: [`MCP tool-use evidence is not valid JSON: ${evidencePath}`],
        risks: [error instanceof Error ? error.message : String(error)]
      };
    }

    const validation = this.schemaRegistry.validate(TOOL_USE_EVIDENCE_SCHEMA_ID, parsed);
    if (!validation.valid) {
      return {
        path: evidencePath,
        checkedArtifacts: [evidencePath],
        missingEvidence: [`MCP tool-use evidence does not match ${TOOL_USE_EVIDENCE_SCHEMA_ID}: ${evidencePath}`],
        risks: validation.errors
      };
    }

    const evidence = validation.value as ToolUseEvidenceArtifact;
    const claimedTools = new Set(evidence.claimedToolsUsed);
    const missingTools = selectedMcpToolIds.filter(toolId => !claimedTools.has(toolId));
    const undeclaredTools = evidence.claimedToolsUsed.filter(toolId => !selectedMcpToolIds.includes(toolId));

    return {
      path: evidencePath,
      checkedArtifacts: [evidencePath],
      missingEvidence: missingTools.map(toolId => `MCP tool-use evidence did not claim selected tool: ${toolId}`),
      risks: undeclaredTools.map(toolId => `MCP tool-use evidence claimed undeclared tool: ${toolId}`)
    };
  }

  private relativeArtifactExists(runDir: string, artifactPath: string): boolean {
    if (!artifactPath || path.isAbsolute(artifactPath)) {
      return false;
    }
    const resolved = path.resolve(runDir, artifactPath);
    const relative = path.relative(runDir, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    return fs.existsSync(resolved);
  }

  private planTaskStatusForStepStatus(status: StepStatus): PlanTaskStatus {
    switch (status) {
      case 'blocked':
        return 'blocked';
      case 'cancelled':
        return 'cancelled';
      case 'succeeded':
        return 'succeeded';
      default:
        return 'failed';
    }
  }

  private updateStage(planRun: PlanRun, stageId: string, status: PlanRunStage['status']): void {
    const stage = planRun.stages?.find(item => item.stageId === stageId);
    if (stage) {
      stage.status = status;
    }
  }

  private updateTask(planRun: PlanRun, stageId: string, taskId: string, status: PlanTaskStatus): void {
    const task = planRun.tasks?.find(item => item.stageId === stageId && item.taskId === taskId);
    if (task) {
      task.status = status;
    }
  }

  private writePlanRun(output: ArtifactSpec, planRun: PlanRun, context: WorkflowExecutionContext): void {
    context.artifactStore.writeJson(output.path, planRun, context.variables);
  }

  private hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
