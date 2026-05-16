import test from 'node:test';
import assert from 'node:assert/strict';
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
