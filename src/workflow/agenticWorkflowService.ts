import { WorkflowRun } from '../types';
import { TraceStore } from './traceStore';
import { WorkflowRegistry } from './workflowRegistry';
import { WorkflowRunnerFactory } from './workflowRunnerFactory';

export const AGENTIC_BOOTSTRAP_WORKFLOW_FILE = '.cursor/workflows/agentic-workflow-bootstrap.json';
export const AGENTIC_BOOTSTRAP_WORKFLOW_ID = 'agentic-workflow-bootstrap';
export const AGENTIC_READY_PLAN_WORKFLOW_FILE = '.cursor/workflows/agentic-workflow-ready-plan.json';
export const AGENTIC_READY_PLAN_WORKFLOW_ID = 'agentic-workflow-ready-plan';

export type AgenticWorkflowStartSource = 'command' | 'agentChat';

export interface StartFromGoalOptions {
  goal: string;
  source: AgenticWorkflowStartSource;
  requestId?: string;
}

export interface StartFromPlanDocumentOptions {
  planPath: string;
  goal?: string;
  source: AgenticWorkflowStartSource;
  requestId?: string;
}

export class AgenticWorkflowService {
  private readonly workflowRunner = this.workflowRunnerFactory.createRunner();

  constructor(
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly workflowRunnerFactory: WorkflowRunnerFactory
  ) {}

  startFromGoal(options: StartFromGoalOptions): string {
    const goal = options.goal.trim();
    if (goal.length === 0) {
      throw new Error('Agentic workflow goal must be non-empty');
    }

    const workflow = this.resolveWorkflow(AGENTIC_BOOTSTRAP_WORKFLOW_FILE, AGENTIC_BOOTSTRAP_WORKFLOW_ID);
    const startedAt = new Date().toISOString();
    const trigger = {
      goal,
      requestId: options.requestId,
      source: options.source,
      startedAt
    };
    const run = this.workflowRunner.start(workflow, {
      trigger,
      variables: { trigger }
    });
    this.recordStartTrace(run, options.source, options.requestId);
    return run.id;
  }

  startFromPlanDocument(options: StartFromPlanDocumentOptions): string {
    const planPath = options.planPath.trim();
    if (planPath.length === 0) {
      throw new Error('Agentic workflow planPath must be non-empty');
    }
    const goal = options.goal?.trim() || `Execute ready plan: ${planPath}`;

    const workflow = this.resolveWorkflow(AGENTIC_READY_PLAN_WORKFLOW_FILE, AGENTIC_READY_PLAN_WORKFLOW_ID);
    const startedAt = new Date().toISOString();
    const trigger = {
      goal,
      planPath,
      requestId: options.requestId,
      source: options.source,
      startedAt
    };
    const run = this.workflowRunner.start(workflow, {
      trigger,
      variables: { trigger }
    });
    this.recordStartTrace(run, options.source, options.requestId, planPath);
    return run.id;
  }

  cancelWorkflowRun(runId: string): boolean {
    return this.workflowRunner.cancel(runId);
  }

  private resolveWorkflow(filePath: string, workflowId: string) {
    this.workflowRegistry.reload();
    const workflow = this.workflowRegistry.get(filePath, workflowId) ?? this.workflowRegistry.getById(workflowId);
    if (!workflow) {
      const errors = this.workflowRegistry.getErrors()
        .map(error => `${error.filePath}: ${error.errors.join('; ')}`)
        .join('\n');
      throw new Error(errors || `Workflow not found: ${workflowId}`);
    }
    return workflow;
  }

  private recordStartTrace(run: WorkflowRun, source: AgenticWorkflowStartSource, requestId?: string, planPath?: string): void {
    new TraceStore(run.runDir).append('agenticWorkflow.started', {
      source,
      requestId,
      planPath
    });
  }
}
