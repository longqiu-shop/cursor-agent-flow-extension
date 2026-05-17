/**
 * Storage manager for hybrid storage (repo JSON + workspace state)
 */

import * as vscode from 'vscode';
import { Schedule, ScheduleStorage, RunRecord } from '../types';
import { resolveWorkspacePath, readJsonFile, writeJsonFile, fileExists } from '../utils/fileUtils';
import * as crypto from 'crypto';

const SCHEDULES_FILE = '.cursor/agent-schedules.json';
const STORAGE_KEYS = {
  USER_OVERRIDES: 'cursorAgentFlow.userOverrides',
  RUN_HISTORY: 'cursorAgentFlow.runHistory',
  LAST_RELOAD: 'cursorAgentFlow.lastReload'
};

interface UserOverride {
  enabled?: boolean;
  lastRun?: {
    status: string;
    finishedAt?: string;
  };
}

export class StorageManager {
  private workspaceState: vscode.Memento;
  private schedulesFile: string;

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
    this.schedulesFile = resolveWorkspacePath(SCHEDULES_FILE);
  }

  /**
   * Load schedules from repo file and merge with user overrides
   */
  async loadSchedules(): Promise<Schedule[]> {
    const repoSchedules = this.loadRepoSchedules();
    const userOverrides = this.getUserOverrides();
    console.log(
      `[StorageManager] Loaded ${repoSchedules.length} schedule(s) from ${this.schedulesFile}: ` +
      repoSchedules.map(schedule => `${schedule.id}:${schedule.targetType}`).join(', ')
    );

    // Merge repo schedules with user overrides
    return repoSchedules.map(schedule => {
      const override = userOverrides[schedule.id];
      if (override) {
        return {
          ...schedule,
          enabled: override.enabled !== undefined ? override.enabled : schedule.enabled
        };
      }
      return schedule;
    });
  }

  /**
   * Load schedules from repo file
   */
  private loadRepoSchedules(): Schedule[] {
    if (!fileExists(this.schedulesFile)) {
      return [];
    }

    const data = readJsonFile<ScheduleStorage>(this.schedulesFile);
    if (!data || !Array.isArray(data.schedules)) {
      return [];
    }

    return data.schedules;
  }

  /**
   * Save schedules to repo file
   */
  async saveSchedules(schedules: Schedule[]): Promise<boolean> {
    const storage: ScheduleStorage = {
      schedules,
      version: '1.0'
    };

    const success = writeJsonFile(this.schedulesFile, storage);
    if (!success) {
      throw new Error(`Failed to write schedules file: ${this.schedulesFile}`);
    }
    return success;
  }

  /**
   * Get user overrides
   */
  getUserOverrides(): Record<string, UserOverride> {
    return this.workspaceState.get<Record<string, UserOverride>>(STORAGE_KEYS.USER_OVERRIDES, {});
  }

  /**
   * Update user override for a schedule
   */
  async updateUserOverride(scheduleId: string, override: Partial<UserOverride>): Promise<void> {
    const overrides = this.getUserOverrides();
    const existing = overrides[scheduleId] || {};
    overrides[scheduleId] = { ...existing, ...override };
    await this.workspaceState.update(STORAGE_KEYS.USER_OVERRIDES, overrides);
  }

  /**
   * Update enabled state for a schedule
   */
  async updateScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
    await this.updateUserOverride(scheduleId, { enabled });
  }

  /**
   * Update last run metadata for a schedule
   */
  async updateLastRun(scheduleId: string, status: string, finishedAt?: string): Promise<void> {
    await this.updateUserOverride(scheduleId, {
      lastRun: {
        status,
        finishedAt
      }
    });
  }

  /**
   * Get run history
   */
  getRunHistory(): RunRecord[] {
    return this.workspaceState.get<RunRecord[]>(STORAGE_KEYS.RUN_HISTORY, []);
  }

  /**
   * Save a run record
   */
  async saveRunRecord(record: RunRecord): Promise<void> {
    const history = this.getRunHistory();
    history.unshift(record); // Add to beginning

    // Keep only last 1000 records
    const trimmed = history.slice(0, 1000);
    await this.workspaceState.update(STORAGE_KEYS.RUN_HISTORY, trimmed);
  }

  /**
   * Get run history for a specific schedule
   */
  getRunHistoryForSchedule(scheduleId: string): RunRecord[] {
    const history = this.getRunHistory();
    return history.filter(r => r.scheduleId === scheduleId);
  }

  /**
   * Clear run history
   */
  async clearRunHistory(): Promise<void> {
    await this.workspaceState.update(STORAGE_KEYS.RUN_HISTORY, []);
  }

  /**
   * Generate a hash for a prompt template (for tracking)
   */
  hashPrompt(prompt: string): string {
    return crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
  }

  /**
   * Get the schedules file path
   */
  getSchedulesFilePath(): string {
    return this.schedulesFile;
  }
}
