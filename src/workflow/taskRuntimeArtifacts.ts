import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PlanTaskStatus } from './planSchemas';

export const TASK_RUNTIME_ARTIFACT_NAMES = {
  inputContext: 'input-context.json',
  taskPrompt: 'task-prompt.md',
  prompt: 'prompt.md',
  validation: 'validation.json',
  provenance: 'provenance.json',
  status: 'status.json',
  memoryProposals: 'memory-proposals.json',
  amendmentProposal: 'plan-amendment-proposal.json'
} as const;

export interface TaskRuntimePaths {
  dir: string;
  inputContext: string;
  taskPrompt: string;
  prompt: string;
  validation: string;
  provenance: string;
  status: string;
  memoryProposals: string;
  amendmentProposal: string;
}

export interface TaskValidationArtifact {
  schemaVersion: '1';
  valid: boolean;
  checkedArtifacts: string[];
  errors: Array<{ code: string; message: string; path?: string }>;
  missingEvidence: string[];
  risks: string[];
}

export interface TaskProvenanceArtifact {
  schemaVersion: '1';
  stageId: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  promptSha256?: string;
  inputContextSha256?: string;
  memoryHash?: string;
  toolInventoryHash?: string;
  selectedTools: string[];
  outputHashes: Array<{ path: string; sha256: string }>;
}

export interface TaskStatusArtifact {
  schemaVersion: '1';
  status: Exclude<PlanTaskStatus, 'pending' | 'running' | 'succeeded'>;
  reason: string;
}

export function taskRuntimePaths(stageId: string, taskId: string): TaskRuntimePaths {
  const dir = `tasks/${stageId}/${taskId}`;
  return {
    dir,
    inputContext: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.inputContext}`,
    taskPrompt: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.taskPrompt}`,
    prompt: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.prompt}`,
    validation: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.validation}`,
    provenance: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.provenance}`,
    status: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.status}`,
    memoryProposals: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.memoryProposals}`,
    amendmentProposal: `${dir}/${TASK_RUNTIME_ARTIFACT_NAMES.amendmentProposal}`
  };
}

export function sha256Text(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function hashExistingFile(runDir: string, relativePath: string): string | undefined {
  const resolved = safeResolveRunPath(runDir, relativePath);
  if (!resolved || !fs.existsSync(resolved)) {
    return undefined;
  }
  return crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
}

export function hashExistingOutputs(runDir: string, relativePaths: string[]): Array<{ path: string; sha256: string }> {
  return relativePaths.flatMap(relativePath => {
    const sha256 = hashExistingFile(runDir, relativePath);
    return sha256 ? [{ path: relativePath, sha256 }] : [];
  });
}

export function safeResolveRunPath(runDir: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const resolved = path.resolve(runDir, relativePath);
  const relative = path.relative(runDir, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}
