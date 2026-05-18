import { CursorAgentRunner } from '../agent/cursorAgentRunner';
import { CursorAgentSubmissionQueue } from '../agent/cursorAgentSubmissionQueue';
import { AgentRegistry } from '../commands/agentRegistry';
import { CommandRegistry } from '../commands/commandRegistry';
import { SkillRegistry } from '../commands/skillRegistry';
import * as path from 'path';
import { getAdditionalMcpDirectories, getAllWorkspaceFolders, getDefaultMcpDescriptorDirectory, getUserHome } from '../utils/fileUtils';
import { AgentStepExecutor } from './agentStepExecutor';
import { FanoutStepExecutor } from './fanoutStepExecutor';
import { JoinStepExecutor } from './joinStepExecutor';
import { PlanImportStepExecutor } from './planImportStepExecutor';
import { PlanRuntimeStepExecutor } from './planRuntimeStepExecutor';
import { ReadJsonStepExecutor } from './readJsonStepExecutor';
import { RunningWorkflowRegistry } from './runningWorkflowRegistry';
import { ToolContextProvider } from './toolContextProvider';
import { ToolInventoryStepExecutor } from './toolInventoryStepExecutor';
import { WorkflowPreferenceProvider, WORKFLOW_PREFERENCES_DIR } from './workflowPreferenceProvider';
import { WorkflowPreferencesStepExecutor } from './workflowPreferencesStepExecutor';
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
    const workflowPreferenceProvider = this.createWorkflowPreferenceProvider();
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
          mcpDescriptorDirectories: this.getMcpDescriptorDirectories(),
          workflowPreferenceProvider
        })),
        new WorkflowPreferencesStepExecutor(workflowPreferenceProvider),
        new PlanRuntimeStepExecutor(this.schemaRegistry)
      ]
    );
  }

  private createWorkflowPreferenceProvider(): WorkflowPreferenceProvider {
    return new WorkflowPreferenceProvider({
      projectDirectories: getAllWorkspaceFolders().map(workspace => path.join(workspace, WORKFLOW_PREFERENCES_DIR)),
      globalDirectories: [path.join(getUserHome(), WORKFLOW_PREFERENCES_DIR)]
    });
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
