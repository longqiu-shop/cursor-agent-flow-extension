import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactSpec, StepStatus, WorkflowStep, WorkflowStepRun } from '../types';
import {
  AuditArtifact,
  MasterPlan,
  PLAN_SCHEMA_VERSION,
  PlanRun,
  PlanRunStage,
  PlanRunTask,
  PlanTask,
  PlanTaskStatus,
  PlanValidationArtifact,
  ToolInventory
} from './planSchemas';
import { ConfidenceGate } from './confidenceGate';
import { OutputContractManager, OutputValidationResult } from './outputContractManager';
import { PlanValidator, PLAN_VALIDATION_ERROR_CODES } from './planValidator';
import { TraceStore } from './traceStore';
import { renderTemplate } from './variableResolver';
import type { WorkflowSchemaRegistry } from './workflowSchemaRegistry';
import type { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import { WorkflowMemoryStore } from './workflowMemoryStore';

interface PlanRuntimeStepInput {
  planArtifact?: string;
  toolInventoryArtifact?: string;
  allowedCapabilities?: string[];
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
    traceStore.append('plan.validated', {
      status: validation.valid ? 'passed' : 'failed',
      artifacts: [{ path: 'plan/plan-validation.json' }]
    });

    if (!validation.valid || !validation.plan) {
      return this.blockBeforePlan(step.output, planRun, context, traceStore, validation.artifact);
    }

    const plan = validation.plan;
    const planHash = this.hash(planContent);
    planRun = this.initializeValidatedPlanRun(plan, planHash, planRun.startedAt);
    memoryStore.seedRunMemory({
      workflowId: context.workflow.id,
      workflowName: context.workflow.name,
      runId: context.run.id,
      runDir: context.run.runDir
    });
    memoryStore.writePlanMemory(plan);

    const childRuns: WorkflowStepRun[] = [];
    for (const stage of plan.stages) {
      this.updateStage(planRun, stage.id, 'running');
      planRun.currentStageId = stage.id;
      this.writePlanRun(step.output, planRun, context);
      traceStore.append('stage.started', { stageId: stage.id });

      for (const task of stage.tasks) {
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
    this.updateTask(planRun, stageId, task.id, 'running');
    planRun.currentStageId = stageId;
    planRun.currentTaskId = task.id;
    traceStore.append('task.started', { stageId, taskId: task.id });

    const inputContext = memoryStore.createInputContext(stageId, task, toolInventory, {
      planMemoryKeys: ['objective', 'riskLevel', 'allowedCapabilities']
    });
    const prompt = this.buildTaskPrompt(task, inputContext.path, outputManager, context);
    const childStep = this.createAgentTaskStep(stageId, task, prompt);
    const child = await context.executeChildStep(childStep, `planRuntime.${stageId}.${task.id}`, context.variables);

    if (child.result.status !== 'succeeded') {
      const status = this.planTaskStatusForStepStatus(child.result.status);
      this.updateTask(planRun, stageId, task.id, status);
      planRun.status = status === 'needsApproval' ? 'needsApproval' : status === 'blocked' ? 'blocked' : status === 'cancelled' ? 'cancelled' : 'failed';
      planRun.blockReason = child.result.blockedReason ?? child.result.error ?? `Task ${task.id} did not succeed`;
      planRun.finishedAt = new Date().toISOString();
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

    const outputValidation = outputManager.validateDeclaredOutputs(task.expectedOutputs, context.variables, {
      taskArtifactDir: `tasks/${stageId}/${task.id}`,
      allowlist: [`tasks/${stageId}/${task.id}/input-context.json`]
    });
    const audit = this.createDeterministicAudit(task, outputValidation, context.run.runDir);
    const auditPath = `audits/${stageId}/${task.id}/audit.json`;
    context.artifactStore.writeJson(auditPath, audit, context.variables);
    traceStore.append('audit.completed', {
      stageId,
      taskId: task.id,
      status: audit.nextAction,
      risks: audit.risks,
      artifacts: [{ path: auditPath }]
    });

    const gate = this.confidenceGate.evaluate(task, audit, outputValidation);
    if (!gate.passed) {
      this.updateTask(planRun, stageId, task.id, gate.status);
      planRun.status = gate.status === 'needsApproval' ? 'needsApproval' : gate.status === 'failed' ? 'failed' : 'blocked';
      planRun.blockReason = gate.reason;
      planRun.finishedAt = new Date().toISOString();
      traceStore.append('confidence.failed', {
        stageId,
        taskId: task.id,
        status: gate.status,
        reason: gate.reason,
        risks: gate.risks
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
    context: WorkflowExecutionContext
  ): string {
    return [
      `Goal: ${task.goal}`,
      '',
      'Success criteria:',
      ...task.successCriteria.map(criterion => `- ${criterion}`),
      '',
      'Required evidence:',
      ...task.evidenceRequired.map(evidence => `- ${evidence}`),
      '',
      `Input context JSON: ${inputContextPath}`,
      '',
      outputManager.buildPromptInstructions(task.expectedOutputs, context.variables)
    ].join('\n');
  }

  private createAgentTaskStep(stageId: string, task: PlanTask, prompt: string): WorkflowStep {
    return {
      id: `plan-${stageId}-${task.id}`,
      type: 'agent',
      input: {
        title: `${stageId}: ${task.id}`,
        prompt,
        freshChat: true,
        submitMode: 'worktree'
      },
      output: task.expectedOutputs[0]
    };
  }

  private createDeterministicAudit(task: PlanTask, outputValidation: OutputValidationResult, runDir: string): AuditArtifact {
    const missingEvidence = task.evidenceRequired.filter(evidence => !this.relativeArtifactExists(runDir, evidence));
    const passed = outputValidation.valid && missingEvidence.length === 0;
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      criteriaResults: task.successCriteria.map(criterion => ({
        criterion,
        passed,
        evidence: outputValidation.checkedArtifacts
      })),
      missingEvidence,
      risks: [],
      nextAction: passed ? 'advance' : task.confidencePolicy.onFailure === 'needsApproval' ? 'needsApproval' : 'block'
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
