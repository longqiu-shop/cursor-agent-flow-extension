import * as fs from 'fs';
import * as path from 'path';
import { WorkflowStep } from '../types';
import { StepExecutionResult, WorkflowExecutionContext, WorkflowStepExecutor } from './workflowRunner';

interface JoinInput {
  from?: string;
  outputPath?: string;
}

export class JoinStepExecutor implements WorkflowStepExecutor {
  readonly type = 'join' as const;

  async execute(step: WorkflowStep, _stepRun: import('../types').WorkflowStepRun, context: WorkflowExecutionContext): Promise<StepExecutionResult> {
    const input = step.input as JoinInput | undefined;
    if (!input?.from) {
      return {
        status: 'failed',
        error: `join step ${step.id} requires input.from`
      };
    }
    if (!input.outputPath) {
      return {
        status: 'failed',
        error: `join step ${step.id} requires input.outputPath`
      };
    }

    const files = this.listMatchingFiles(context, input.from);
    const markdown = this.renderMarkdownIndex(files);
    const outputArtifact = context.artifactStore.writeText(input.outputPath, markdown, context.variables);

    return {
      status: 'succeeded',
      outputArtifact,
      output: {
        files,
        count: files.length
      }
    };
  }

  private listMatchingFiles(context: WorkflowExecutionContext, from: string): string[] {
    const absolutePattern = context.artifactStore.resolveArtifactPath(from, context.variables);
    const directory = path.dirname(absolutePattern);
    const basenamePattern = path.basename(absolutePattern);
    const matcher = this.globBasenameToRegex(basenamePattern);

    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && matcher.test(entry.name))
      .map(entry => path.join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b));
  }

  private renderMarkdownIndex(files: string[]): string {
    if (files.length === 0) {
      return '# Workflow Join Output\n\nNo artifacts matched.\n';
    }

    const sections = files.map(filePath => {
      const content = fs.readFileSync(filePath, 'utf-8');
      return [
        `## ${path.basename(filePath)}`,
        '',
        '```markdown',
        content.trimEnd(),
        '```'
      ].join('\n');
    });

    return ['# Workflow Join Output', '', ...sections].join('\n\n') + '\n';
  }

  private globBasenameToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  }
}
