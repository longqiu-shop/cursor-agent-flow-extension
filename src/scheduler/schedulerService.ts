/**
 * Scheduler service for managing cron-based schedule execution
 */

import * as vscode from 'vscode';
import { Schedule } from '../types';
import { StorageManager } from '../storage/storageManager';
import { CommandRegistry } from '../commands/commandRegistry';
import { SkillRegistry } from '../commands/skillRegistry';
import { AgentRegistry } from '../commands/agentRegistry';
import { ExecutionEngine } from '../execution/executionEngine';
import { getNextRunTime } from '../utils/cronUtils';

interface ScheduledJob {
  schedule: Schedule;
  timer?: NodeJS.Timeout;
  nextRun?: Date;
}

export class SchedulerService implements vscode.Disposable {
  private storageManager: StorageManager;
  private commandRegistry: CommandRegistry;
  private executionEngine: ExecutionEngine;
  private jobs: Map<string, ScheduledJob> = new Map();
  private checkInterval?: NodeJS.Timeout;
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    storageManager: StorageManager,
    commandRegistry: CommandRegistry,
    skillRegistry: SkillRegistry,
    agentRegistry: AgentRegistry
  ) {
    this.storageManager = storageManager;
    this.commandRegistry = commandRegistry;
    this.executionEngine = new ExecutionEngine(
      storageManager,
      commandRegistry,
      skillRegistry,
      agentRegistry
    );
  }

  /**
   * Initialize the scheduler
   */
  async initialize(): Promise<void> {
    const schedules = await this.storageManager.loadSchedules();
    
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.scheduleJob(schedule);
      }
    }

    // Check every minute for due schedules
    this.checkInterval = setInterval(() => {
      this.checkDueSchedules();
    }, 60000); // Check every minute

    console.log(`Scheduler initialized with ${this.jobs.size} active schedules`);
  }

  /**
   * Add a schedule
   */
  async addSchedule(schedule: Schedule): Promise<void> {
    const schedules = await this.storageManager.loadSchedules();
    schedules.push(schedule);
    await this.storageManager.saveSchedules(schedules);

    if (schedule.enabled) {
      this.scheduleJob(schedule);
    }

    this.onDidChangeEmitter.fire();
  }

  /**
   * Update a schedule
   */
  async updateSchedule(schedule: Schedule): Promise<void> {
    const schedules = await this.storageManager.loadSchedules();
    const index = schedules.findIndex(s => s.id === schedule.id);
    
    if (index === -1) {
      throw new Error(`Schedule not found: ${schedule.id}`);
    }

    schedules[index] = schedule;
    await this.storageManager.saveSchedules(schedules);

    // Reschedule
    this.unscheduleJob(schedule.id);
    if (schedule.enabled) {
      this.scheduleJob(schedule);
    }

    this.onDidChangeEmitter.fire();
  }

  /**
   * Remove a schedule
   */
  async removeSchedule(scheduleId: string): Promise<void> {
    const schedules = await this.storageManager.loadSchedules();
    const filtered = schedules.filter(s => s.id !== scheduleId);
    await this.storageManager.saveSchedules(filtered);

    this.unscheduleJob(scheduleId);
    this.onDidChangeEmitter.fire();
  }

  /**
   * Enable a schedule
   */
  async enableSchedule(scheduleId: string): Promise<void> {
    await this.storageManager.updateScheduleEnabled(scheduleId, true);
    
    const schedules = await this.storageManager.loadSchedules();
    const schedule = schedules.find(s => s.id === scheduleId);
    if (schedule) {
      schedule.enabled = true;
      this.scheduleJob(schedule);
      this.onDidChangeEmitter.fire();
    }
  }

  /**
   * Disable a schedule
   */
  async disableSchedule(scheduleId: string): Promise<void> {
    await this.storageManager.updateScheduleEnabled(scheduleId, false);
    this.unscheduleJob(scheduleId);
    this.onDidChangeEmitter.fire();
  }

  /**
   * Run a schedule immediately
   */
  async runSchedule(scheduleId: string): Promise<void> {
    const schedules = await this.storageManager.loadSchedules();
    const schedule = schedules.find(s => s.id === scheduleId);
    
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    // Check if already running
    if (this.executionEngine.isScheduleRunning(scheduleId)) {
      throw new Error(`Schedule "${schedule.name}" is already running`);
    }

    await this.executionEngine.execute(schedule);
  }

  /**
   * Run a schedule object directly (for test runs)
   */
  async runScheduleDirect(schedule: Schedule): Promise<void> {
    // Check if already running
    if (this.executionEngine.isScheduleRunning(schedule.id)) {
      throw new Error(`Schedule "${schedule.name}" is already running`);
    }

    await this.executionEngine.execute(schedule);
  }

  /**
   * Reload schedules from storage
   */
  async reloadSchedules(): Promise<void> {
    // Clear existing jobs
    for (const [scheduleId] of this.jobs) {
      this.unscheduleJob(scheduleId);
    }

    // Reload and reschedule
    await this.initialize();
    this.onDidChangeEmitter.fire();
  }

  /**
   * Get all schedules
   */
  async getSchedules(): Promise<Schedule[]> {
    return this.storageManager.loadSchedules();
  }

  /**
   * Get next run time for a schedule
   */
  getNextRunTime(scheduleId: string): Date | undefined {
    const job = this.jobs.get(scheduleId);
    return job?.nextRun;
  }

  /**
   * Schedule a job
   */
  private scheduleJob(schedule: Schedule): void {
    try {
      const nextRun = getNextRunTime(schedule.cron, schedule.timezone);
      if (!nextRun) {
        console.error(`Invalid cron expression for schedule ${schedule.id}: ${schedule.cron}`);
        return;
      }

      const job: ScheduledJob = {
        schedule,
        nextRun
      };

      // Calculate delay until next run
      const delay = nextRun.getTime() - Date.now();
      
      if (delay > 0) {
        job.timer = setTimeout(() => {
          this.executeSchedule(schedule.id);
        }, delay);
      } else {
        // If already past due, schedule for next occurrence
        this.rescheduleJob(schedule.id);
      }

      this.jobs.set(schedule.id, job);
    } catch (error) {
      console.error(`Failed to schedule job for ${schedule.id}:`, error);
    }
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job?.timer) {
      clearTimeout(job.timer);
    }
    this.jobs.delete(scheduleId);
  }

  /**
   * Reschedule a job
   */
  private rescheduleJob(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (!job) {
      return;
    }

    if (job.timer) {
      clearTimeout(job.timer);
    }

    const nextRun = getNextRunTime(job.schedule.cron, job.schedule.timezone);
    if (!nextRun) {
      return;
    }

    job.nextRun = nextRun;
    const delay = nextRun.getTime() - Date.now();
    
    if (delay > 0) {
      job.timer = setTimeout(() => {
        this.executeSchedule(scheduleId);
      }, delay);
    }
  }

  /**
   * Execute a schedule
   */
  private async executeSchedule(scheduleId: string): Promise<void> {
    const job = this.jobs.get(scheduleId);
    if (!job) {
      return;
    }

    // Check if already running
    if (this.executionEngine.isScheduleRunning(scheduleId)) {
      console.log(`Schedule ${scheduleId} is already running, skipping`);
      this.rescheduleJob(scheduleId);
      return;
    }

    try {
      await this.executionEngine.execute(job.schedule);
    } catch (error) {
      console.error(`Failed to execute schedule ${scheduleId}:`, error);
      vscode.window.showErrorMessage(
        `Failed to execute schedule "${job.schedule.name}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Reschedule for next run
    this.rescheduleJob(scheduleId);
  }

  /**
   * Check for due schedules (called every minute)
   */
  private checkDueSchedules(): void {
    const now = Date.now();
    
    for (const [scheduleId, job] of this.jobs) {
      if (!job.schedule.enabled) {
        continue;
      }

      if (job.nextRun && job.nextRun.getTime() <= now) {
        // Schedule is due, execute it
        this.executeSchedule(scheduleId);
      }
    }
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    for (const [scheduleId] of this.jobs) {
      this.unscheduleJob(scheduleId);
    }

    this.onDidChangeEmitter.dispose();
  }
}
