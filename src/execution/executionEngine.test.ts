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
});
