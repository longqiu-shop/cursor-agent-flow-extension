import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command } from '../types';
import { ToolContextProvider } from './toolContextProvider';

const command = (id: string, description: string): Command => ({
  id,
  filePath: `/commands/${id}.md`,
  description,
  instructions: description
});

test('snapshots selected command sources with stable tool ids', () => {
  const provider = new ToolContextProvider({
    commands: [command('daily-summary', 'Summarize daily changes')],
    skills: [command('review-pr', 'Review pull requests')],
    agents: [command('planner', 'Plan work')]
  });

  const inventory = provider.snapshot({ include: ['commands', 'skills'] });

  assert.equal(inventory.schemaVersion, '1');
  assert.deepEqual(inventory.tools.map(tool => tool.id), [
    'commands.daily-summary',
    'skills.review-pr'
  ]);
  assert.deepEqual(inventory.tools.map(tool => tool.capabilities), [['read'], ['read']]);
});

test('includes workflow primitives and runtime actions by default', () => {
  const provider = new ToolContextProvider({});
  const inventory = provider.snapshot();

  assert.equal(inventory.tools.some(tool => tool.id === 'workflow.agent'), true);
  assert.equal(inventory.tools.some(tool => tool.id === 'runtime.block'), true);
});

test('discovers MCP tool descriptors from Cursor MCP cache layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-mcp-tools-'));
  const toolsDir = path.join(dir, 'user-github', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'list_pull_requests.json'), JSON.stringify({
    name: 'list_pull_requests',
    description: 'List pull requests in a GitHub repository'
  }), 'utf-8');

  const provider = new ToolContextProvider({
    mcpDescriptorDirectories: [dir]
  });
  const inventory = provider.snapshot({ include: ['mcpTools'] });

  assert.deepEqual(inventory.tools.map(tool => tool.id), ['mcp.user-github.list_pull_requests']);
  assert.equal(inventory.tools[0].source, 'mcpTools');
  assert.match(inventory.tools[0].description ?? '', /GitHub repository/);
});

test('deduplicates colliding command ids deterministically', () => {
  const provider = new ToolContextProvider({
    commands: [
      command('review', 'First review command'),
      command('review', 'Second review command')
    ]
  });

  const inventory = provider.snapshot({ include: ['commands'] });

  assert.equal(inventory.tools.length, 2);
  assert.equal(new Set(inventory.tools.map(tool => tool.id)).size, 2);
  assert.equal(inventory.tools[0].id, 'commands.review');
  assert.match(inventory.tools[1].id, /^commands\.review\.[a-f0-9]{8}$/);
});
