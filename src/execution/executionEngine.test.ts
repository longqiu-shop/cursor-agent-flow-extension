import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

test('execution engine wires agentic workflow executors and MCP descriptors', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/execution/executionEngine.ts'), 'utf-8');

  assert.match(source, /new ToolInventoryStepExecutor\(ToolContextProvider\.fromRegistries\(\{/);
  assert.match(source, /mcpDescriptorDirectories: this\.getMcpDescriptorDirectories\(\)/);
  assert.match(source, /new PlanRuntimeStepExecutor\(schemaRegistry\)/);
});

test('extension manifest exposes the agentic workflow command path', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    contributes: {
      commands: Array<{ command: string }>;
      menus: {
        'view/title': Array<{ command: string; when: string }>;
        'view/item/context': Array<{ command: string; when: string }>;
      };
    };
  };

  assert.equal(
    manifest.contributes.commands.some(command => command.command === 'cursorAgentFlow.startAgenticWorkflow'),
    true
  );
  assert.equal(
    manifest.contributes.menus['view/title'].some(menu => (
      menu.command === 'cursorAgentFlow.startAgenticWorkflow'
      && menu.when === 'view == cursorAgentFlow'
    )),
    true
  );
  assert.equal(
    manifest.contributes.commands.some(command => command.command === 'cursorAgentFlow.rerunWorkflowRun'),
    true
  );
  assert.equal(
    manifest.contributes.menus['view/item/context'].some(menu => (
      menu.command === 'cursorAgentFlow.rerunWorkflowRun'
      && menu.when === 'view == cursorAgentFlow && viewItem == workflow-run-rerunnable'
    )),
    true
  );
});

test('extension wires agent chat request files to the agentic workflow starter', () => {
  const extensionSource = fs.readFileSync(path.resolve(process.cwd(), 'src/extension.ts'), 'utf-8');
  const commandSource = fs.readFileSync(path.resolve(process.cwd(), 'src/commands/extensionCommands.ts'), 'utf-8');

  assert.match(
    extensionSource,
    /new AgentChatTriggerService\(\(goal, requestId\) => commands\.startAgenticWorkflowFromGoal\(goal, requestId\)\)/
  );
  assert.doesNotMatch(extensionSource, /[^A-Z_]AGENT_CHAT_REQUESTS_DIR/);
  assert.doesNotMatch(extensionSource, /`\$\{AGENT_CHAT_REQUESTS_DIR\}\/\*\.json`/);
  assert.doesNotMatch(extensionSource, /\.cursor\/agent-flow-requests/);
  assert.match(extensionSource, /GLOBAL_AGENT_CHAT_REQUESTS_DIR/);
  assert.match(extensionSource, /fs\.mkdirSync\(GLOBAL_AGENT_CHAT_REQUESTS_DIR, \{ recursive: true \}\)/);
  assert.match(extensionSource, /new vscode\.RelativePattern\(vscode\.Uri\.file\(GLOBAL_AGENT_CHAT_REQUESTS_DIR\), '\*\.json'\)/);
  assert.match(extensionSource, /listAgentChatRequestFiles\(GLOBAL_AGENT_CHAT_REQUESTS_DIR\)/);
  assert.match(extensionSource, /globalAgentChatTriggerWatcher\.onDidCreate\(queueAgentChatTrigger\)/);
  assert.match(extensionSource, /globalAgentChatTriggerWatcher\.onDidChange\(queueAgentChatTrigger\)/);
  assert.match(commandSource, /async startAgenticWorkflowFromGoal\(goal: string, requestId\?: string\): Promise<string>/);
  assert.match(commandSource, /const runId = await this\.schedulerService\.runScheduleDirect\(schedule\)/);
});

test('workflow runs persist trigger metadata for reruns', () => {
  const engineSource = fs.readFileSync(path.resolve(process.cwd(), 'src/execution/executionEngine.ts'), 'utf-8');
  const runnerSource = fs.readFileSync(path.resolve(process.cwd(), 'src/workflow/workflowRunner.ts'), 'utf-8');

  assert.match(engineSource, /const trigger = \{/);
  assert.match(engineSource, /goal: schedule\.promptTemplate \?\? schedule\.name/);
  assert.match(engineSource, /requestId: schedule\.metadata\?\.requestId/);
  assert.match(engineSource, /trigger,/);
  assert.match(runnerSource, /trigger\?: WorkflowRunTrigger/);
  assert.match(runnerSource, /trigger: options\.trigger/);
});
