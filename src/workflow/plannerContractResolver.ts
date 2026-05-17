import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PlannerContractMetadata, WorkflowDefinition, WorkflowStep } from '../types';

export const AGENTIC_WORKFLOW_CONTRACT_ID = 'agentic-workflow-planner';
export const AGENTIC_WORKFLOW_CONTRACT_VERSION = '1';
export const AGENTIC_WORKFLOW_BOOTSTRAP_ID = 'agentic-workflow-bootstrap';
export const EXTENSION_ASSETS_WORKFLOWS_DIR = path.join('assets', 'workflows');
export const SOURCE_ASSETS_WORKFLOWS_DIR = path.join('src', 'assets', 'workflows');

export type PlannerContractSource = PlannerContractMetadata['source'];

export interface PlannerContractMetadataOptions {
  source: PlannerContractSource;
  extensionVersion?: string;
  now?: () => string;
}

export function getExtensionDefaultWorkflowDirectories(extensionPath: string): string[] {
  return [
    path.join(extensionPath, 'out', EXTENSION_ASSETS_WORKFLOWS_DIR),
    path.join(extensionPath, SOURCE_ASSETS_WORKFLOWS_DIR)
  ];
}

export function createPlannerContractMetadata(
  workflow: WorkflowDefinition,
  options: PlannerContractMetadataOptions
): PlannerContractMetadata | undefined {
  if (workflow.id !== AGENTIC_WORKFLOW_BOOTSTRAP_ID) {
    return undefined;
  }

  const plannerStep = workflow.steps.find(step => step.id === 'planner' && step.type === 'agent');
  const promptPath = plannerStep ? resolvePlannerPromptPath(workflow.filePath, plannerStep) : undefined;
  const promptContent = promptPath && fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, 'utf-8')
    : undefined;

  return {
    contractId: AGENTIC_WORKFLOW_CONTRACT_ID,
    contractVersion: AGENTIC_WORKFLOW_CONTRACT_VERSION,
    source: options.source,
    workflowPath: workflow.filePath,
    ...(promptPath ? { promptPath } : {}),
    ...(promptContent !== undefined ? { sha256: sha256(promptContent) } : {}),
    resolvedAt: options.now?.() ?? new Date().toISOString(),
    ...(options.extensionVersion ? { extensionVersion: options.extensionVersion } : {})
  };
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resolvePlannerPromptPath(workflowFilePath: string, step: WorkflowStep): string | undefined {
  const promptFile = step.input?.promptFile;
  if (typeof promptFile !== 'string' || promptFile.trim().length === 0) {
    return undefined;
  }
  if (path.isAbsolute(promptFile)) {
    return undefined;
  }

  const normalized = path.normalize(promptFile);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    const workflowDir = path.dirname(workflowFilePath);
    const assetsDir = path.dirname(workflowDir);
    const resolvedPromptPath = path.resolve(workflowDir, normalized);
    const relativeToAssets = path.relative(assetsDir, resolvedPromptPath);
    const allowedExtensionAssetPath = path.basename(workflowDir) === 'workflows'
      && path.basename(assetsDir) === 'assets'
      && relativeToAssets.length > 0
      && !relativeToAssets.startsWith('..')
      && !path.isAbsolute(relativeToAssets);
    if (!allowedExtensionAssetPath) {
      return undefined;
    }
  }

  return path.resolve(path.dirname(workflowFilePath), promptFile);
}
