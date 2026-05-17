import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowStep, WorkflowStepRun } from '../types';
import { MASTER_PLAN_SCHEMA_ID } from './planSchemas';
import { renderTemplate } from './variableResolver';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';
import { TraceStore } from './traceStore';
import { TRACE_EVENTS } from './traceEvents';

interface PlanImportInput {
  planPath?: string;
}

interface ImportValidationArtifact {
  schemaVersion: '1';
  valid: boolean;
  sourcePath?: string;
  canonicalPath?: string;
  format?: 'json' | 'markdown';
  errors: string[];
}

export class PlanImportStepExecutor implements WorkflowStepExecutor {
  readonly type = 'planImport' as const;

  constructor(
    private readonly schemaRegistry: WorkflowSchemaRegistry,
    private readonly trustedDirectories: string[] = defaultTrustedPlanDirectories(),
    private readonly homeDirectory: string = os.homedir()
  ) {}

  async execute(step: WorkflowStep, _stepRun: WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const traceStore = new TraceStore(context.run.runDir);
    traceStore.append('planImport.started', { stepId: step.id });

    const input = step.input as PlanImportInput | undefined;
    const validationPath = 'plan/import-validation.json';
    const sourceDocumentPath = 'plan/source-plan-document.json';
    const masterPlanPath = step.output?.path ?? 'plan/master-plan.json';

    try {
      if (!input?.planPath || input.planPath.trim().length === 0) {
        return this.block(context, traceStore, validationPath, ['planImport input.planPath is required']);
      }

      const requestedPath = renderTemplate(input.planPath, context.variables);
      const safePath = this.resolveTrustedPlanPath(requestedPath);
      if (!safePath.ok) {
        return this.block(context, traceStore, validationPath, [safePath.error], requestedPath);
      }

      const content = fs.readFileSync(safePath.realPath, 'utf-8');
      const parsed = this.parsePlanDocument(content);
      if (!parsed.ok) {
        return this.block(context, traceStore, validationPath, [parsed.error], requestedPath, safePath.realPath);
      }

      const validation = this.schemaRegistry.validate(MASTER_PLAN_SCHEMA_ID, parsed.plan);
      if (!validation.valid || !validation.value) {
        return this.block(
          context,
          traceStore,
          validationPath,
          validation.errors,
          requestedPath,
          safePath.realPath,
          parsed.format
        );
      }

      context.artifactStore.writeJson(sourceDocumentPath, {
        schemaVersion: '1',
        sourcePath: requestedPath,
        canonicalPath: safePath.realPath,
        format: parsed.format,
        sha256: this.sha256(content)
      });
      const outputArtifact = context.artifactStore.writeJson(masterPlanPath, validation.value);
      context.artifactStore.writeJson(validationPath, {
        schemaVersion: '1',
        valid: true,
        sourcePath: requestedPath,
        canonicalPath: safePath.realPath,
        format: parsed.format,
        errors: []
      } satisfies ImportValidationArtifact);

      traceStore.append('planImport.completed', {
        stepId: step.id,
        sourcePath: requestedPath,
        canonicalPath: safePath.realPath,
        format: parsed.format,
        artifacts: [
          { path: sourceDocumentPath, role: 'sourcePlanDocument' },
          { path: masterPlanPath, role: 'masterPlan' },
          { path: validationPath, role: 'importValidation' }
        ]
      });
      traceStore.appendTyped(TRACE_EVENTS.PLAN_CREATED, {
        stepId: step.id,
        source: 'planImport',
        artifacts: [{ path: masterPlanPath, role: 'masterPlan' }]
      });

      return {
        status: 'succeeded',
        outputArtifact,
        output: validation.value
      };
    } catch (error) {
      return this.block(context, traceStore, validationPath, [error instanceof Error ? error.message : String(error)]);
    }
  }

  private block(
    context: WorkflowExecutionContext,
    traceStore: TraceStore,
    validationPath: string,
    errors: string[],
    sourcePath?: string,
    canonicalPath?: string,
    format?: 'json' | 'markdown'
  ): StepExecutionResult {
    const outputArtifact = context.artifactStore.writeJson(validationPath, {
      schemaVersion: '1',
      valid: false,
      ...(sourcePath ? { sourcePath } : {}),
      ...(canonicalPath ? { canonicalPath } : {}),
      ...(format ? { format } : {}),
      errors
    } satisfies ImportValidationArtifact);
    const reason = errors.join('; ');
    traceStore.append('planImport.failed', {
      sourcePath,
      canonicalPath,
      format,
      reason,
      artifacts: [{ path: validationPath, role: 'importValidation' }]
    });
    return {
      status: 'blocked',
      blockedReason: reason,
      outputArtifact
    };
  }

  private parsePlanDocument(content: string): (
    | { ok: true; plan: unknown; format: 'json' | 'markdown' }
    | { ok: false; error: string }
  ) {
    try {
      return { ok: true, plan: JSON.parse(content), format: 'json' };
    } catch {
      // Fall through to explicit markdown block parsing.
    }

    const blocks = [...content.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)]
      .filter(match => /\bjson\b/i.test(match[1]) && /\bmaster-plan@1\b/i.test(match[1]));
    if (blocks.length === 0) {
      return { ok: false, error: 'Markdown plan document must contain exactly one ```json master-plan@1 executable block' };
    }
    if (blocks.length > 1) {
      return { ok: false, error: 'Markdown plan document contains multiple executable master-plan@1 JSON blocks' };
    }

    try {
      return { ok: true, plan: JSON.parse(blocks[0][2]), format: 'markdown' };
    } catch (error) {
      return { ok: false, error: `Executable master-plan@1 block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private resolveTrustedPlanPath(planPath: string): { ok: true; realPath: string } | { ok: false; error: string } {
    const expandedPath = this.expandHomePath(planPath);
    const absolutePath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(this.defaultBaseDirectory(), expandedPath);
    if (!fs.existsSync(absolutePath)) {
      return { ok: false, error: `Plan document does not exist: ${planPath}` };
    }
    if (!fs.statSync(absolutePath).isFile()) {
      return { ok: false, error: `Plan document is not a file: ${planPath}` };
    }

    const realPath = fs.realpathSync.native(absolutePath);
    const trustedDirs = this.trustedDirectories
      .filter(dir => fs.existsSync(dir))
      .map(dir => fs.realpathSync.native(dir));
    const trusted = trustedDirs.some(dir => this.isInside(realPath, dir) || this.isInside(realPath.toLowerCase(), dir.toLowerCase()));
    if (!trusted) {
      return { ok: false, error: `Plan document must be inside a trusted directory: ${planPath}` };
    }

    return { ok: true, realPath };
  }

  private expandHomePath(planPath: string): string {
    if (planPath === '~') {
      return this.homeDirectory;
    }
    if (planPath.startsWith('~/') || planPath.startsWith(`~${path.sep}`)) {
      return path.join(this.homeDirectory, planPath.slice(2));
    }
    return planPath;
  }

  private defaultBaseDirectory(): string {
    return getWorkspaceFoldersSafe()[0] ?? process.cwd();
  }

  private isInside(candidatePath: string, trustedDir: string): boolean {
    const relative = path.relative(trustedDir, candidatePath);
    return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

export function defaultTrustedPlanDirectories(): string[] {
  return [
    ...getWorkspaceFoldersSafe(),
    path.join(os.homedir(), '.cursor', 'plans')
  ];
}

function getWorkspaceFoldersSafe(): string[] {
  try {
    // Load VS Code only inside the Extension Host; plain Node tests do not provide it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? getWorkspaceFallback();
  } catch {
    return getWorkspaceFallback();
  }
}

function getWorkspaceFallback(): string[] {
  const fallback = process.env.AGENT_SCHEDULES_WORKSPACE;
  return fallback && fallback.trim().length > 0 ? [fallback] : [];
}
