import { CursorAgentRunner } from '../agent/cursorAgentRunner';
import { CursorAgentSubmissionQueue } from '../agent/cursorAgentSubmissionQueue';
import { AgentRegistry } from '../commands/agentRegistry';
import { CommandRegistry } from '../commands/commandRegistry';
import { SkillRegistry } from '../commands/skillRegistry';
import { getAdditionalMcpDirectories, getDefaultMcpDescriptorDirectory } from '../utils/fileUtils';
import { AgentStepExecutor } from './agentStepExecutor';
import { FanoutStepExecutor } from './fanoutStepExecutor';
import { JoinStepExecutor } from './joinStepExecutor';
import { PlanImportStepExecutor } from './planImportStepExecutor';
import { PlanRuntimeStepExecutor } from './planRuntimeStepExecutor';
import { ReadJsonStepExecutor } from './readJsonStepExecutor';
import { RunningWorkflowRegistry } from './runningWorkflowRegistry';
import { ToolContextProvider } from './toolContextProvider';
import { ToolInventoryStepExecutor } from './toolInventoryStepExecutor';
import { WorkflowRunner } from './workflowRunner';
import { WorkflowSchemaRegistry } from './workflowSchemaRegistry';

export class WorkflowRunnerFactory {
  constructor(
    private readonly commandRegistry: CommandRegistry,
    private readonly skillRegistry: SkillRegistry,
    private readonly agentRegistry: AgentRegistry,
    private readonly runningWorkflowRegistry: RunningWorkflowRegistry,
    private readonly submissionQueue: CursorAgentSubmissionQueue,
    private readonly schemaRegistry: WorkflowSchemaRegistry
  ) {}

  createRunner(): WorkflowRunner {
    const agentRunner = new CursorAgentRunner();
    return new WorkflowRunner(
      this.runningWorkflowRegistry,
      this.schemaRegistry,
      [
        new AgentStepExecutor(agentRunner, this.submissionQueue),
        new ReadJsonStepExecutor(),
        new FanoutStepExecutor(),
        new JoinStepExecutor(),
        new PlanImportStepExecutor(this.schemaRegistry),
        new ToolInventoryStepExecutor(ToolContextProvider.fromRegistries({
          commandRegistry: this.commandRegistry,
          skillRegistry: this.skillRegistry,
          agentRegistry: this.agentRegistry,
          mcpDescriptorDirectories: this.getMcpDescriptorDirectories()
        })),
        new PlanRuntimeStepExecutor(this.schemaRegistry)
      ]
    );
  }

  private getMcpDescriptorDirectories(): string[] {
    try {
      const defaultDir = getDefaultMcpDescriptorDirectory();
      return [
        ...(defaultDir ? [defaultDir] : []),
        ...getAdditionalMcpDirectories()
      ];
    } catch {
      return getAdditionalMcpDirectories();
    }
  }
}
