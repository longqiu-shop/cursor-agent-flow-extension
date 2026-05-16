import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactSpec } from '../types';
import {
  OUTPUT_CONTRACT_SCHEMA_ID,
  OutputContractArtifact,
  PLAN_SCHEMA_VERSION
} from './planSchemas';
import { renderTemplate, WorkflowVariables } from './variableResolver';
import type { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export const OUTPUT_CONTRACT_ERROR_CODES = {
  MISSING_REQUIRED_OUTPUT: 'MISSING_REQUIRED_OUTPUT',
  INVALID_JSON_OUTPUT: 'INVALID_JSON_OUTPUT',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  TEMP_ARTIFACT_PRESENT: 'TEMP_ARTIFACT_PRESENT',
  UNEXPECTED_ARTIFACT: 'UNEXPECTED_ARTIFACT',
  PATH_ESCAPES_RUN_DIR: 'PATH_ESCAPES_RUN_DIR'
} as const;

export interface OutputValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface OutputValidationResult {
  valid: boolean;
  checkedArtifacts: string[];
  errors: OutputValidationError[];
}

export interface OutputContractPromptOptions {
  statusPath?: string;
}

export interface OutputContractValidationOptions {
  taskArtifactDir?: string;
  allowlist?: string[];
}

export class OutputContractManager {
  constructor(
    private readonly runDir: string,
    private readonly schemaRegistry: WorkflowSchemaRegistry
  ) {
    if (!path.isAbsolute(runDir)) {
      throw new Error(`runDir must be absolute: ${runDir}`);
    }
  }

  createContract(expectedOutputs: ArtifactSpec[]): OutputContractArtifact {
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      expectedOutputs
    };
  }

  buildPromptInstructions(
    expectedOutputs: ArtifactSpec[],
    variables: WorkflowVariables,
    options: OutputContractPromptOptions = {}
  ): string {
    const lines = [
      'Task output contract:',
      '',
      `The output contract schema is ${OUTPUT_CONTRACT_SCHEMA_ID}.`,
      'Write each declared output by first writing complete content to the .tmp path, then atomically renaming it to the final path.',
      ''
    ];

    expectedOutputs.forEach((output, index) => {
      const finalPath = this.resolveOutputPath(output.path, variables);
      lines.push(
        `${index + 1}. ${output.required === false ? 'Optional' : 'Required'} ${output.format} output:`,
        `   tmp: ${finalPath}.tmp`,
        `   final: ${finalPath}`
      );
      if (output.schema) {
        lines.push(`   schema: ${output.schema}`);
      }
    });

    if (options.statusPath) {
      lines.push(
        '',
        'If blocked or failed before producing the required outputs, write a status artifact to:',
        options.statusPath
      );
    }

    return lines.join('\n');
  }

  validateDeclaredOutputs(
    expectedOutputs: ArtifactSpec[],
    variables: WorkflowVariables,
    options: OutputContractValidationOptions = {}
  ): OutputValidationResult {
    const errors: OutputValidationError[] = [];
    const checkedArtifacts: string[] = [];
    const declaredPaths = new Set<string>();

    for (const output of expectedOutputs) {
      const resolved = this.safeResolveOutputPath(output.path, variables);
      if (!resolved.ok) {
        errors.push(resolved.error);
        continue;
      }

      checkedArtifacts.push(resolved.path);
      declaredPaths.add(resolved.path);
      const tmpPath = `${resolved.path}.tmp`;

      if (!fs.existsSync(resolved.path)) {
        if (fs.existsSync(tmpPath)) {
          errors.push({
            code: OUTPUT_CONTRACT_ERROR_CODES.TEMP_ARTIFACT_PRESENT,
            message: `Temporary output exists without final promotion: ${tmpPath}`,
            path: tmpPath
          });
        } else if (output.required !== false) {
          errors.push({
            code: OUTPUT_CONTRACT_ERROR_CODES.MISSING_REQUIRED_OUTPUT,
            message: `Required output was not produced: ${resolved.path}`,
            path: resolved.path
          });
        }
        continue;
      }

      if (output.format === 'json') {
        const validation = this.validateJsonOutput(resolved.path, output.schema);
        if (!validation.valid) {
          errors.push(...validation.errors);
        }
      }
    }

    if (options.taskArtifactDir) {
      errors.push(...this.validateUnexpectedArtifacts(options.taskArtifactDir, declaredPaths, options.allowlist ?? []));
    }

    return {
      valid: errors.length === 0,
      checkedArtifacts,
      errors
    };
  }

  resolveOutputPath(outputPathTemplate: string, variables: WorkflowVariables): string {
    const result = this.safeResolveOutputPath(outputPathTemplate, variables);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.path;
  }

  private validateJsonOutput(artifactPath: string, schemaId: string | undefined): OutputValidationResult {
    const content = fs.readFileSync(artifactPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      return {
        valid: false,
        checkedArtifacts: [artifactPath],
        errors: [{
          code: OUTPUT_CONTRACT_ERROR_CODES.INVALID_JSON_OUTPUT,
          message: error instanceof Error ? error.message : String(error),
          path: artifactPath
        }]
      };
    }

    const validation = this.schemaRegistry.validate(schemaId, parsed);
    if (!validation.valid) {
      return {
        valid: false,
        checkedArtifacts: [artifactPath],
        errors: validation.errors.map(message => ({
          code: OUTPUT_CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED,
          message,
          path: artifactPath
        }))
      };
    }

    return {
      valid: true,
      checkedArtifacts: [artifactPath],
      errors: []
    };
  }

  private validateUnexpectedArtifacts(taskArtifactDir: string, declaredPaths: Set<string>, allowlist: string[]): OutputValidationError[] {
    const resolvedDir = this.resolveRunRelativePath(taskArtifactDir);
    if (!fs.existsSync(resolvedDir)) {
      return [];
    }

    const allowlisted = new Set(allowlist.map(item => this.resolveRunRelativePath(item)));
    const errors: OutputValidationError[] = [];
    for (const artifactPath of this.listFilesRecursively(resolvedDir)) {
      if (artifactPath.endsWith('.tmp')) {
        continue;
      }
      if (!declaredPaths.has(artifactPath) && !allowlisted.has(artifactPath)) {
        errors.push({
          code: OUTPUT_CONTRACT_ERROR_CODES.UNEXPECTED_ARTIFACT,
          message: `Unexpected artifact found in task directory: ${artifactPath}`,
          path: artifactPath
        });
      }
    }
    return errors;
  }

  private listFilesRecursively(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listFilesRecursively(fullPath));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private safeResolveOutputPath(outputPathTemplate: string, variables: WorkflowVariables): { ok: true; path: string } | { ok: false; error: OutputValidationError } {
    let renderedPath: string;
    try {
      renderedPath = renderTemplate(outputPathTemplate, variables);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: OUTPUT_CONTRACT_ERROR_CODES.PATH_ESCAPES_RUN_DIR,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }

    try {
      return {
        ok: true,
        path: this.resolveRunRelativePath(renderedPath)
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: OUTPUT_CONTRACT_ERROR_CODES.PATH_ESCAPES_RUN_DIR,
          message: error instanceof Error ? error.message : String(error),
          path: renderedPath
        }
      };
    }
  }

  private resolveRunRelativePath(relativePath: string): string {
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
}
