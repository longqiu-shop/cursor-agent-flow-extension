/**
 * Execution engine for running schedules (mock implementation)
 */

import { Schedule, Command, RunRecord, TargetType } from '../types';
import { StorageManager } from '../storage/storageManager';
import { CommandRegistry } from '../commands/commandRegistry';
import { SkillRegistry } from '../commands/skillRegistry';
import { AgentRegistry } from '../commands/agentRegistry';
import { CursorAgentRunner, AgentExecutionResult } from '../agent/cursorAgentRunner';
import * as vscode from 'vscode';

interface RunningExecution {
  runId: string;
  schedule: Schedule;
  command?: Command;
  startTime: Date;
  timeout?: NodeJS.Timeout;
  cancelled: boolean;
}

export class ExecutionEngine {
  private runningExecutions: Map<string, RunningExecution> = new Map();
  private storageManager: StorageManager;
  private commandRegistry: CommandRegistry;
  private skillRegistry: SkillRegistry;
  private agentRegistry: AgentRegistry;
  private agentRunner: CursorAgentRunner;

  constructor(
    storageManager: StorageManager,
    commandRegistry: CommandRegistry,
    skillRegistry: SkillRegistry,
    agentRegistry: AgentRegistry
  ) {
    this.storageManager = storageManager;
    this.commandRegistry = commandRegistry;
    this.skillRegistry = skillRegistry;
    this.agentRegistry = agentRegistry;
    this.agentRunner = new CursorAgentRunner();
  }

  private getContextCommand(schedule: Schedule): Command | undefined {
    if (!schedule.commandRef) return undefined;
    const { filePath, commandId } = schedule.commandRef;
    const type = schedule.targetType;
    if (type === 'command') return this.commandRegistry.getCommand(filePath, commandId);
    if (type === 'skill') return this.skillRegistry.get(filePath, commandId);
    // Agent; legacy 'subagent' from old schedules (create-subagent writes to .cursor/agents)
    if (type === 'agent' || (type as string) === 'subagent') return this.agentRegistry.get(filePath, commandId);
    return undefined;
  }

  /**
   * Execute a schedule
   */
  async execute(schedule: Schedule): Promise<string> {
    console.log(`[ExecutionEngine] Starting execution for schedule: ${schedule.name} (${schedule.id})`);
    console.log(`[ExecutionEngine] Target type: ${schedule.targetType}, Mode: ${schedule.executionMode}`);
    
    const runId = this.generateRunId();
    console.log(`[ExecutionEngine] Generated run ID: ${runId}`);

    // Get context item (command, skill, agent, or subagent) if needed
    let command: Command | undefined;
    if (schedule.targetType === 'prompt') {
      console.log(`[ExecutionEngine] Using inline prompt: ${schedule.promptTemplate?.substring(0, 50)}...`);
    } else if (schedule.commandRef) {
      command = this.getContextCommand(schedule);
      if (!command) {
        throw new Error(`${schedule.targetType} not found: ${schedule.commandRef.commandId} in ${schedule.commandRef.filePath}`);
      }
      console.log(`[ExecutionEngine] Found ${schedule.targetType}: ${command.id}`);
    }

    // Check if already running
    const existingRun = Array.from(this.runningExecutions.values()).find(
      e => e.schedule.id === schedule.id && !e.cancelled
    );
    if (existingRun) {
      throw new Error(`Schedule ${schedule.name} is already running`);
    }

    // Create run record
    const runRecord: RunRecord = {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      targetType: schedule.targetType,
      commandId: command?.id,
      promptHash: schedule.promptTemplate ? this.storageManager.hashPrompt(schedule.promptTemplate) : undefined,
      startedAt: new Date().toISOString(),
      status: 'running'
    };

    // Start execution based on mode
    const execution: RunningExecution = {
      runId,
      schedule,
      command,
      startTime: new Date(),
      cancelled: false
    };

    this.runningExecutions.set(runId, execution);

    // Show immediate feedback
    const message = schedule.targetType === 'prompt' 
      ? `Starting execution: "${schedule.name}" (prompt: ${schedule.promptTemplate?.substring(0, 30)}...)`
      : `Starting execution: "${schedule.name}" (command: ${command?.id})`;
    
    console.log(`[ExecutionEngine] ${message}`);
    vscode.window.showInformationMessage(message);

    // Execute based on mode
    if (schedule.executionMode === 'ide') {
      console.log(`[ExecutionEngine] Executing in local IDE mode`);
      this.executeLocal(execution, runRecord).catch(err => {
        console.error(`Execution failed for ${schedule.name}:`, err);
        vscode.window.showErrorMessage(
          `Execution failed for "${schedule.name}": ${err instanceof Error ? err.message : 'Unknown error'}`
        );
        runRecord.status = 'failure';
        runRecord.error = err instanceof Error ? err.message : 'Unknown error';
        runRecord.finishedAt = new Date().toISOString();
        this.storageManager.saveRunRecord(runRecord).catch(console.error);
        this.runningExecutions.delete(runId);
      });
    } else {
      console.log(`[ExecutionEngine] Executing in cloud mode`);
      this.executeCloud(execution, runRecord).catch(err => {
        console.error(`Execution failed for ${schedule.name}:`, err);
        vscode.window.showErrorMessage(
          `Execution failed for "${schedule.name}": ${err instanceof Error ? err.message : 'Unknown error'}`
        );
        runRecord.status = 'failure';
        runRecord.error = err instanceof Error ? err.message : 'Unknown error';
        runRecord.finishedAt = new Date().toISOString();
        this.storageManager.saveRunRecord(runRecord).catch(console.error);
        this.runningExecutions.delete(runId);
      });
    }

    return runId;
  }

  /**
   * Execute locally using Cursor agent
   */
  private async executeLocal(execution: RunningExecution, runRecord: RunRecord): Promise<void> {
    const { schedule, command } = execution;
    
    try {
      console.log(`[ExecutionEngine] Starting real agent execution for ${schedule.name}`);
      
      if (execution.cancelled) {
        runRecord.status = 'failure';
        runRecord.error = 'Execution cancelled';
        runRecord.finishedAt = new Date().toISOString();
        await this.storageManager.saveRunRecord(runRecord);
        this.runningExecutions.delete(execution.runId);
        return;
      }

      // Prepare prompt
      let prompt = '';
      if (schedule.targetType === 'prompt') {
        // Substitute variables in prompt template
        prompt = this.agentRunner.substituteVariables(schedule.promptTemplate ?? '');
      } else if (command) {
        // Execute command
        const result = await this.agentRunner.executeCommand(schedule, command);
        await this.handleExecutionResult(execution, runRecord, result);
        return;
      } else {
        throw new Error('No prompt or command provided');
      }

      // Execute prompt
      const result = await this.agentRunner.executePrompt(schedule, prompt);
      await this.handleExecutionResult(execution, runRecord, result);
      
    } catch (error) {
      console.error(`[ExecutionEngine] Execution error for ${schedule.name}:`, error);
      runRecord.status = 'failure';
      runRecord.error = error instanceof Error ? error.message : 'Unknown error';
      runRecord.finishedAt = new Date().toISOString();
      runRecord.executionTime = (Date.now() - execution.startTime.getTime()) / 1000;
      await this.storageManager.saveRunRecord(runRecord);
      this.runningExecutions.delete(execution.runId);
      
      vscode.window.showErrorMessage(
        `Execution failed for "${schedule.name}": ${runRecord.error}`
      );
    }
  }

  /**
   * Handle execution result
   */
  private async handleExecutionResult(
    execution: RunningExecution,
    runRecord: RunRecord,
    result: AgentExecutionResult
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    const actualTime = (Date.now() - execution.startTime.getTime()) / 1000;

    // Check constraints
    const maxRuntime = execution.schedule.constraints?.maxRuntime;
    if (maxRuntime && actualTime > maxRuntime) {
      runRecord.status = 'failure';
      runRecord.error = `Execution exceeded max runtime of ${maxRuntime}s`;
    } else {
      runRecord.status = result.success ? 'success' : 'failure';
      runRecord.summary = result.output || (result.success ? 'Execution completed' : result.error);
      runRecord.filesChanged = result.filesChanged;
      runRecord.error = result.error;
    }

    runRecord.finishedAt = finishedAt;
    runRecord.executionTime = actualTime;

    await this.storageManager.saveRunRecord(runRecord);
    this.runningExecutions.delete(execution.runId);

    // Show notification
    const statusMessage = runRecord.status === 'success' 
      ? `Schedule "${execution.schedule.name}" completed successfully`
      : `Schedule "${execution.schedule.name}" failed: ${runRecord.error}`;
    
    if (runRecord.status === 'success') {
      vscode.window.showInformationMessage(statusMessage);
    } else {
      vscode.window.showErrorMessage(statusMessage);
    }
  }

  /**
   * Execute in cloud (mock)
   */
  private async executeCloud(execution: RunningExecution, runRecord: RunRecord): Promise<void> {
    const { schedule, command } = execution;

    // Simulate cloud execution with polling
    const pollInterval = 1000; // Poll every second
    let pollCount = 0;
    const maxPolls = 10; // Max 10 seconds

    const poll = setInterval(async () => {
      pollCount++;

      if (execution.cancelled) {
        clearInterval(poll);
        return;
      }

      // Simulate completion after random polls
      if (pollCount >= Math.floor(Math.random() * maxPolls) + 3) {
        clearInterval(poll);

        const finishedAt = new Date().toISOString();
        const actualTime = (Date.now() - execution.startTime.getTime()) / 1000;

        runRecord.status = 'success';
        runRecord.summary = this.generateMockSummary(schedule, command);
        runRecord.filesChanged = Math.floor(Math.random() * 5);
        runRecord.finishedAt = finishedAt;
        runRecord.executionTime = actualTime;

        await this.storageManager.saveRunRecord(runRecord);
        this.runningExecutions.delete(execution.runId);

        vscode.window.showInformationMessage(
          `Schedule "${schedule.name}" completed: ${runRecord.status}`
        );
      }
    }, pollInterval);
  }

  /**
   * Generate mock summary
   */
  private generateMockSummary(schedule: Schedule, command?: Command): string {
    if (command) {
      return `Executed command "${command.id}": ${command.description || 'No description'}`;
    } else {
      const promptPreview = schedule.promptTemplate 
        ? schedule.promptTemplate.substring(0, 100) + (schedule.promptTemplate.length > 100 ? '...' : '')
        : 'No prompt';
      return `Executed prompt: ${promptPreview}`;
    }
  }

  /**
   * Cancel a running execution
   */
  async cancelExecution(runId: string): Promise<boolean> {
    const execution = this.runningExecutions.get(runId);
    if (!execution) {
      return false;
    }

    execution.cancelled = true;
    if (execution.timeout) {
      clearTimeout(execution.timeout);
    }

    // Update run record
    const runRecord: RunRecord = {
      scheduleId: execution.schedule.id,
      scheduleName: execution.schedule.name,
      targetType: execution.schedule.targetType,
      commandId: execution.command?.id,
      startedAt: execution.startTime.toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'failure',
      error: 'Execution cancelled by user',
      executionTime: (Date.now() - execution.startTime.getTime()) / 1000
    };

    await this.storageManager.saveRunRecord(runRecord);
    this.runningExecutions.delete(runId);

    return true;
  }

  /**
   * Get execution status
   */
  getExecutionStatus(runId: string): { running: boolean; scheduleId?: string } {
    const execution = this.runningExecutions.get(runId);
    if (!execution) {
      return { running: false };
    }
    return {
      running: !execution.cancelled,
      scheduleId: execution.schedule.id
    };
  }

  /**
   * Check if a schedule is currently running
   */
  isScheduleRunning(scheduleId: string): boolean {
    return Array.from(this.runningExecutions.values()).some(
      e => e.schedule.id === scheduleId && !e.cancelled
    );
  }

  /**
   * Generate a unique run ID
   */
  private generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
