import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MasterPlan, PlanTask, ToolInventory, ToolInventoryEntry } from './planSchemas';

export interface WorkflowMemorySnapshot {
  schemaVersion: '1';
  values: Record<string, unknown>;
}

export interface TaskInputContext {
  schemaVersion: '1';
  task: {
    stageId: string;
    taskId: string;
    goal: string;
    role?: string;
    taskBoundary?: PlanTask['taskBoundary'];
    dependsOn?: string[];
    inputArtifacts?: string[];
    outputPurpose?: string;
    successCriteria: string[];
    evidenceRequired: string[];
  };
  memory: {
    run: Record<string, unknown>;
    plan: Record<string, unknown>;
  };
  tools: ToolInventoryEntry[];
  provenance: {
    memoryHash: string;
    toolInventoryHash: string;
  };
}

export interface TaskInputContextOptions {
  runMemoryKeys?: string[];
  planMemoryKeys?: string[];
}

export class WorkflowMemoryStore {
  constructor(private readonly runDir: string) {
    if (!path.isAbsolute(runDir)) {
      throw new Error(`runDir must be absolute: ${runDir}`);
    }
  }

  seedRunMemory(values: Record<string, unknown>): string {
    return this.writeMemorySnapshot('memory/run-memory.json', values);
  }

  writePlanMemory(plan: MasterPlan): string {
    return this.writeMemorySnapshot('memory/plan-memory.json', {
      objective: plan.objective,
      riskLevel: plan.riskLevel,
      allowedCapabilities: plan.allowedCapabilities,
      stageIds: plan.stages.map(stage => stage.id)
    });
  }

  createInputContext(
    stageId: string,
    task: PlanTask,
    toolInventory: ToolInventory,
    options: TaskInputContextOptions = {}
  ): { path: string; value: TaskInputContext } {
    const runMemory = this.pick(this.readMemorySnapshot('memory/run-memory.json').values, options.runMemoryKeys);
    const planMemory = this.pick(this.readMemorySnapshot('memory/plan-memory.json').values, options.planMemoryKeys);
    const selectedTools = this.selectTools(toolInventory, task.tools ?? []);
    const value: TaskInputContext = {
      schemaVersion: '1',
      task: {
        stageId,
        taskId: task.id,
        goal: task.goal,
        ...(task.role ? { role: task.role } : {}),
        ...(task.taskBoundary ? { taskBoundary: task.taskBoundary } : {}),
        ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
        ...(task.inputArtifacts ? { inputArtifacts: task.inputArtifacts } : {}),
        ...(task.outputPurpose ? { outputPurpose: task.outputPurpose } : {}),
        successCriteria: task.successCriteria,
        evidenceRequired: task.evidenceRequired
      },
      memory: {
        run: runMemory,
        plan: planMemory
      },
      tools: selectedTools,
      provenance: {
        memoryHash: this.hashCanonicalJson({ run: runMemory, plan: planMemory }),
        toolInventoryHash: this.hashCanonicalJson(selectedTools)
      }
    };

    const artifactPath = this.resolveRunPath(`tasks/${stageId}/${task.id}/input-context.json`);
    this.writeJsonAtomic(artifactPath, value);
    return {
      path: artifactPath,
      value
    };
  }

  readMemorySnapshot(relativePath: string): WorkflowMemorySnapshot {
    const artifactPath = this.resolveRunPath(relativePath);
    if (!fs.existsSync(artifactPath)) {
      return {
        schemaVersion: '1',
        values: {}
      };
    }

    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as WorkflowMemorySnapshot;
    if (parsed.schemaVersion !== '1' || !parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
      throw new Error(`Invalid memory snapshot: ${relativePath}`);
    }
    return parsed;
  }

  private writeMemorySnapshot(relativePath: string, values: Record<string, unknown>): string {
    const artifactPath = this.resolveRunPath(relativePath);
    this.writeJsonAtomic(artifactPath, {
      schemaVersion: '1',
      values
    } satisfies WorkflowMemorySnapshot);
    return artifactPath;
  }

  private pick(values: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
    if (!keys) {
      return {};
    }

    const picked: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        picked[key] = values[key];
      }
    }
    return picked;
  }

  private selectTools(toolInventory: ToolInventory, toolIds: string[]): ToolInventoryEntry[] {
    const selected = new Set(toolIds);
    return toolInventory.tools.filter(tool => selected.has(tool.id));
  }

  private resolveRunPath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`Path must be relative to runDir: ${relativePath}`);
    }

    const resolved = path.resolve(this.runDir, relativePath);
    const relative = path.relative(this.runDir, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes runDir: ${relativePath}`);
    }
    return resolved;
  }

  private writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  private hashCanonicalJson(value: unknown): string {
    return crypto.createHash('sha256').update(this.canonicalJson(value)).digest('hex');
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
