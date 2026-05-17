import * as fs from 'fs';
import * as path from 'path';
import type { PlanRun } from '../workflow/planSchemas';

export interface PlanRunTaskModel {
  stageId: string;
  taskId: string;
  status: string;
  selectedTools: string[];
  validationStatus?: string;
  auditNextAction?: string;
  missingEvidence: string[];
  reason?: string;
  artifacts: Array<{ label: string; relativePath: string; absolutePath: string; exists: boolean }>;
}

export interface PlanRunModel {
  available: boolean;
  status: string;
  blockReason?: string;
  interruptedResumeUnsupported: boolean;
  currentStageId?: string;
  currentTaskId?: string;
  tasks: PlanRunTaskModel[];
  errors: string[];
}

interface BuildPlanRunModelOptions {
  activeRunIds?: Set<string>;
  runId?: string;
}

export function buildPlanRunModel(runDir: string, options: BuildPlanRunModelOptions = {}): PlanRunModel {
  const errors: string[] = [];
  const planRun = readJson<PlanRun>(runDir, 'plan-run.json', errors);
  if (!planRun) {
    return {
      available: false,
      status: 'missing',
      interruptedResumeUnsupported: false,
      tasks: [],
      errors
    };
  }

  const interruptedResumeUnsupported = planRun.status === 'running'
    && options.runId !== undefined
    && options.activeRunIds !== undefined
    && !options.activeRunIds.has(options.runId);

  return {
    available: true,
    status: interruptedResumeUnsupported ? 'interruptedResumeUnsupported' : planRun.status,
    blockReason: planRun.blockReason,
    interruptedResumeUnsupported,
    currentStageId: planRun.currentStageId,
    currentTaskId: planRun.currentTaskId,
    tasks: (planRun.tasks ?? []).map(task => buildTaskModel(runDir, task.stageId, task.taskId, task.status, errors)),
    errors
  };
}

function buildTaskModel(
  runDir: string,
  stageId: string,
  taskId: string,
  status: string,
  errors: string[]
): PlanRunTaskModel {
  const taskDir = `tasks/${stageId}/${taskId}`;
  const validation = readJson<Record<string, unknown>>(runDir, `${taskDir}/validation.json`, errors);
  const audit = readJson<Record<string, unknown>>(runDir, `audits/${stageId}/${taskId}/audit.json`, errors);
  const statusArtifact = readJson<Record<string, unknown>>(runDir, `${taskDir}/status.json`, errors);
  const provenance = readJson<Record<string, unknown>>(runDir, `${taskDir}/provenance.json`, errors);
  const missingEvidence = Array.isArray(validation?.missingEvidence)
    ? validation.missingEvidence.filter(item => typeof item === 'string') as string[]
    : Array.isArray(audit?.missingEvidence)
      ? audit.missingEvidence.filter(item => typeof item === 'string') as string[]
      : [];
  const selectedTools = Array.isArray(provenance?.selectedTools)
    ? provenance.selectedTools.filter(item => typeof item === 'string') as string[]
    : [];

  return {
    stageId,
    taskId,
    status,
    selectedTools,
    validationStatus: typeof validation?.valid === 'boolean' ? (validation.valid ? 'passed' : 'failed') : undefined,
    auditNextAction: typeof audit?.nextAction === 'string' ? audit.nextAction : undefined,
    missingEvidence,
    reason: typeof statusArtifact?.reason === 'string' ? statusArtifact.reason : undefined,
    artifacts: [
      artifactLink(runDir, `${taskDir}/input-context.json`, 'input context'),
      artifactLink(runDir, `${taskDir}/task-prompt.md`, 'task prompt'),
      artifactLink(runDir, `${taskDir}/prompt.md`, 'submitted prompt'),
      artifactLink(runDir, `${taskDir}/validation.json`, 'validation'),
      artifactLink(runDir, `${taskDir}/provenance.json`, 'provenance'),
      artifactLink(runDir, `audits/${stageId}/${taskId}/audit.json`, 'audit')
    ]
  };
}

function artifactLink(runDir: string, relativePath: string, label: string): PlanRunTaskModel['artifacts'][number] {
  const absolutePath = path.join(runDir, relativePath);
  return {
    label,
    relativePath,
    absolutePath,
    exists: fs.existsSync(absolutePath)
  };
}

function readJson<T>(runDir: string, relativePath: string, errors: string[]): T | undefined {
  const filePath = path.join(runDir, relativePath);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
