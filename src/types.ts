/**
 * TypeScript interfaces for Cursor Agent Scheduler
 */

export type TargetType = 'prompt' | 'command' | 'skill' | 'agent';
export type ExecutionMode = 'ide' | 'cloud';
export type ScheduleType = 'cron' | 'interval';
export type OutputType = 'markdown' | 'pr' | 'diff' | 'none';
export type RunStatus = 'success' | 'failure' | 'skipped' | 'running';

/**
 * Reference to a command file
 */
export interface CommandRef {
  filePath: string;
  commandId: string;
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
  executionMode: ExecutionMode;
  workspaceFolder?: string; // Workspace folder path
  outputConfig: OutputConfig;
  constraints?: ExecutionConstraints;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    description?: string;
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
 * Run record for execution history
 */
export interface RunRecord {
  scheduleId: string;
  scheduleName: string;
  targetType: TargetType;
  commandId?: string;
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
