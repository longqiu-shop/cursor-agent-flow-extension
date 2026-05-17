/**
 * TypeScript interfaces for Cursor Agent Scheduler
 */

export type TargetType = 'prompt' | 'command' | 'skill' | 'agent' | 'workflow';
export type ExecutionMode = 'ide' | 'cloud';
export type ScheduleType = 'cron' | 'interval';
export type OutputType = 'markdown' | 'pr' | 'diff' | 'none';
export type RunStatus = 'success' | 'failure' | 'skipped' | 'running';
export type WorkflowStepType = 'agent' | 'readJson' | 'fanout' | 'join' | 'toolInventory' | 'planRuntime';
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'timedOut'
  | 'interrupted'
  | 'cancelled';
export type StepStatus = WorkflowStatus;

/**
 * Reference to a command file
 */
export interface CommandRef {
  filePath: string;
  commandId: string;
}

/**
 * Reference to a workflow definition file
 */
export interface WorkflowRef {
  filePath: string;
  workflowId: string;
}

/**
 * Output configuration for schedule execution
 */
export interface OutputConfig {
  type: OutputType;
  location?: string; // For markdown output
}

/**
 * Safety constraints for execution
 */
export interface ExecutionConstraints {
  maxRuntime?: number; // seconds
  maxFilesChanged?: number;
  allowedPaths?: string[]; // Path allowlist
}

/**
 * Schedule definition
 */
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  cron: string; // Cron expression
  timezone?: string; // IANA timezone (e.g., "America/New_York")
  targetType: TargetType;
  promptTemplate?: string; // If targetType is 'prompt'
  commandRef?: CommandRef; // If targetType is 'command'
  workflowRef?: WorkflowRef; // If targetType is 'workflow'
  executionMode: ExecutionMode;
  workspaceFolder?: string; // Workspace folder path
  outputConfig: OutputConfig;
  constraints?: ExecutionConstraints;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    description?: string;
    requestId?: string;
  };
}

/**
 * Parsed command from markdown file
 */
export interface Command {
  id: string;
  filePath: string;
  description?: string;
  instructions: string; // Full markdown content or extracted sections
  sections?: {
    role?: string;
    tasks?: string;
    rules?: string;
    context?: string;
  };
  constraints?: ExecutionConstraints;
}

/**
 * Artifact contract for workflow step outputs.
 *
 * path is rendered as a workflow template, then resolved relative to the run directory.
 */
export interface ArtifactSpec {
  path: string;
  format: 'json' | 'markdown' | 'text';
  required?: boolean;
  schema?: string;
}

/**
 * Workflow definition loaded from .cursor/workflows/*.json
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  filePath: string;
  description?: string;
  version: number;
  defaults?: {
    timeoutSeconds?: number;
    onStepFailure?: 'stop' | 'continue';
    fanoutConcurrency?: 'sequential';
  };
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  name?: string;
  input?: Record<string, unknown>;
  output?: ArtifactSpec;
  timeoutSeconds?: number;
  required?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  scheduleId?: string;
  trigger?: WorkflowRunTrigger;
  status: WorkflowStatus;
  runDir: string;
  currentStepId?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  steps: WorkflowStepRun[];
}

export interface WorkflowRunTrigger {
  goal?: string;
  requestId?: string;
  scheduleId?: string;
  startedAt?: string;
}

export interface WorkflowStepRun {
  stepRunId: string;
  definitionId: string;
  type: WorkflowStepType;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  title?: string;
  promptPreview?: string;
  expectedArtifact?: string;
  outputArtifact?: string;
  error?: string;
  blockedReason?: string;
  childRuns?: WorkflowStepRun[];
}

export interface StepStatusArtifact {
  status: 'blocked' | 'failed';
  reason: string;
}

/**
 * Run record for execution history
 */
export interface RunRecord {
  scheduleId: string;
  scheduleName: string;
  targetType: TargetType;
  commandId?: string;
  workflowId?: string;
  promptHash?: string; // Hash of prompt template for inline prompts
  startedAt: string; // ISO timestamp
  finishedAt?: string; // ISO timestamp
  status: RunStatus;
  summary?: string;
  outputLocation?: string;
  error?: string;
  filesChanged?: number;
  executionTime?: number; // seconds
}

/**
 * Execution configuration
 */
export interface ExecutionConfig {
  mode: ExecutionMode;
  workspaceFolder: string;
  outputConfig: OutputConfig;
  constraints?: ExecutionConstraints;
}

/**
 * Schedule storage structure
 */
export interface ScheduleStorage {
  schedules: Schedule[];
  version?: string;
}
