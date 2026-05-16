import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArtifactSpec } from '../types';
import { readFileSafe, readJsonFile, writeFileAtomic, writeJsonFileAtomic } from '../utils/fileUtils';
import { renderTemplate, WorkflowVariables } from './variableResolver';
import { SchemaValidationResult, WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export type ArtifactWaitStatus = 'found' | 'timeout' | 'cancelled';

export interface ArtifactWaitOptions {
  timeoutMs: number;
  token?: vscode.CancellationToken;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoffAfterMs?: number;
}

export interface ArtifactWaitResult<T = unknown> {
  status: ArtifactWaitStatus;
  artifactPath: string;
  value?: T;
  content?: string;
  errors?: string[];
  elapsedMs: number;
}

export class ArtifactStore {
  constructor(
    private readonly runDir: string,
    private readonly schemaRegistry: WorkflowSchemaRegistry
  ) {
    if (!path.isAbsolute(runDir)) {
      throw new Error(`runDir must be absolute: ${runDir}`);
    }
  }

  resolveArtifactPath(artifactPathTemplate: string, variables: WorkflowVariables = {}): string {
    const renderedPath = renderTemplate(artifactPathTemplate, variables);
    this.validateRelativePath(renderedPath);

    const resolvedPath = path.resolve(this.runDir, renderedPath);
    const relativePath = path.relative(this.runDir, resolvedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`Artifact path escapes runDir: ${artifactPathTemplate}`);
    }

    return resolvedPath;
  }

  writeText(artifactPathTemplate: string, content: string, variables: WorkflowVariables = {}): string {
    const artifactPath = this.resolveArtifactPath(artifactPathTemplate, variables);
    if (!writeFileAtomic(artifactPath, content)) {
      throw new Error(`Failed to write artifact: ${artifactPath}`);
    }
    return artifactPath;
  }

  writeJson(artifactPathTemplate: string, value: unknown, variables: WorkflowVariables = {}): string {
    const artifactPath = this.resolveArtifactPath(artifactPathTemplate, variables);
    if (!writeJsonFileAtomic(artifactPath, value)) {
      throw new Error(`Failed to write JSON artifact: ${artifactPath}`);
    }
    return artifactPath;
  }

  readText(artifactPathTemplate: string, variables: WorkflowVariables = {}): string | undefined {
    return readFileSafe(this.resolveArtifactPath(artifactPathTemplate, variables));
  }

  readJson<T>(artifactPathTemplate: string, variables: WorkflowVariables = {}): T | undefined {
    return readJsonFile<T>(this.resolveArtifactPath(artifactPathTemplate, variables));
  }

  validateJsonValue(schemaId: string | undefined, value: unknown): SchemaValidationResult {
    return this.schemaRegistry.validate(schemaId, value);
  }

  async waitForArtifact<T = unknown>(
    spec: ArtifactSpec,
    variables: WorkflowVariables,
    options: ArtifactWaitOptions
  ): Promise<ArtifactWaitResult<T>> {
    const artifactPath = this.resolveArtifactPath(spec.path, variables);
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs;
    const initialIntervalMs = options.initialIntervalMs ?? 2000;
    const maxIntervalMs = options.maxIntervalMs ?? 10000;
    const backoffAfterMs = options.backoffAfterMs ?? 30000;
    let lastSize: number | undefined;
    let stablePolls = 0;
    let lastErrors: string[] | undefined;

    while (Date.now() - startedAt < timeoutMs) {
      if (options.token?.isCancellationRequested) {
        return {
          status: 'cancelled',
          artifactPath,
          elapsedMs: Date.now() - startedAt
        };
      }

      const stat = this.tryStat(artifactPath);
      if (stat?.isFile()) {
        if (lastSize === stat.size) {
          stablePolls++;
        } else {
          stablePolls = 1;
          lastSize = stat.size;
        }

        if (stablePolls >= 2) {
          const result = this.tryReadCompletedArtifact<T>(artifactPath, spec);
          if (result.valid) {
            return {
              status: 'found',
              artifactPath,
              value: result.value,
              content: result.content,
              elapsedMs: Date.now() - startedAt
            };
          }
          lastErrors = result.errors;
        }
      }

      await this.sleep(this.nextPollInterval(Date.now() - startedAt, initialIntervalMs, maxIntervalMs, backoffAfterMs));
    }

    return {
      status: 'timeout',
      artifactPath,
      errors: lastErrors,
      elapsedMs: Date.now() - startedAt
    };
  }

  private tryReadCompletedArtifact<T>(artifactPath: string, spec: ArtifactSpec): {
    valid: boolean;
    value?: T;
    content?: string;
    errors?: string[];
  } {
    const content = readFileSafe(artifactPath);
    if (content === undefined) {
      return {
        valid: false,
        errors: [`Artifact disappeared before it could be read: ${artifactPath}`]
      };
    }

    if (spec.format === 'json') {
      try {
        const parsed = JSON.parse(content);
        const validation = this.validateJsonValue(spec.schema, parsed);
        if (!validation.valid) {
          return {
            valid: false,
            errors: validation.errors
          };
        }
        return {
          valid: true,
          value: validation.value as T,
          content
        };
      } catch (error) {
        return {
          valid: false,
          errors: [error instanceof Error ? error.message : String(error)]
        };
      }
    }

    return {
      valid: true,
      value: content as T,
      content
    };
  }

  private validateRelativePath(artifactPath: string): void {
    if (!artifactPath || artifactPath.trim().length === 0) {
      throw new Error('Artifact path is required');
    }

    if (path.isAbsolute(artifactPath)) {
      throw new Error(`Artifact path must be relative to runDir: ${artifactPath}`);
    }

    const normalized = path.normalize(artifactPath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
      throw new Error(`Artifact path must not traverse outside runDir: ${artifactPath}`);
    }
  }

  private tryStat(artifactPath: string): fs.Stats | undefined {
    try {
      return fs.statSync(artifactPath);
    } catch {
      return undefined;
    }
  }

  private nextPollInterval(
    elapsedMs: number,
    initialIntervalMs: number,
    maxIntervalMs: number,
    backoffAfterMs: number
  ): number {
    if (elapsedMs < backoffAfterMs) {
      return initialIntervalMs;
    }
    return maxIntervalMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
