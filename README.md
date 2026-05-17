# Cursor Agent Flow

Cursor Agent Flow is a Cursor/VS Code extension for scheduling and orchestrating Cursor agents from workspace configuration. It can run one-off prompts, reusable command files, Cursor skills, agent definitions, and multi-step workflows on cron schedules.

The extension is designed for local Cursor automation. It stores schedules in the workspace, submits prompts through Cursor's agent UI, tracks run history, and records workflow artifacts under `.cursor/agent-runs/`.

## Features

- Schedule Cursor agent work with cron expressions.
- Run schedules manually from the Agent Schedules view.
- Use inline prompt templates with `{date}`, `{time}`, `{datetime}`, and `{timestamp}` substitutions.
- Load reusable commands from `.cursor/commands`, `~/.cursor/commands`, and configured extra directories.
- Load Cursor skills from `.cursor/skills`, `~/.cursor/skills-cursor`, and configured extra directories.
- Load agent definitions from `.cursor/agents`, `~/.cursor/agents`, and configured extra directories.
- Run JSON workflow definitions from `.cursor/workflows`.
- Start an agentic workflow MVP that builds a tool inventory, asks a planner agent for a master plan, and executes that plan through the runtime.
- Track run history in workspace state.
- Inspect, open, and cancel active workflow runs.

## Requirements

- Cursor or VS Code compatible with the VS Code extension API declared in `package.json`.
- Node.js 18 or newer.
- pnpm 10.x. This repo currently declares `pnpm@10.28.0`.

Local agent execution depends on Cursor commands such as `workbench.action.chat.open`, `composer.triggerCreateWorktreeButton`, and `composer.sendToAgent`. Cloud execution is not implemented; use local IDE mode.

## Install From Source

```bash
git clone https://github.com/longqiu-shop/cursor-agent-flow-extension.git
cd cursor-agent-flow-extension
pnpm install --frozen-lockfile
pnpm run package
```

This creates a VSIX in the project root:

```bash
cursor-agent-flow-1.0.1.vsix
```

Install it in Cursor with `Extensions: Install from VSIX...`.

## Development

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Compile TypeScript
pnpm run compile

# Compile in watch mode
pnpm run watch

# Run unit tests
pnpm test

# Build a distributable VSIX
pnpm run package
```

For interactive extension development, open this folder in Cursor and press `F5` to launch an Extension Development Host.

## Packaging

The package step bundles the extension entrypoint with esbuild and then asks `vsce` to package the bundled output:

```bash
pnpm run package
```

`vsce` does not understand pnpm dependency layouts well, so the extension is bundled first and packaged with `--no-dependencies`. `.vscodeignore` keeps local development files, sources, pnpm store data, and tests out of the VSIX while preserving `out/extension.js` and its source map.

## Unit Tests

Tests use Node's built-in test runner against compiled JavaScript:

```bash
pnpm test
```

The `pretest` script runs:

```bash
pnpm run clean
pnpm run compile
pnpm run lint
```

Then the test script runs:

```bash
node --test out/workflow/*.test.js out/ui/*.test.js
```

## Extension Commands

The extension contributes these command palette commands:

| Command | Purpose |
| --- | --- |
| `Agent Schedules: Add Schedule` | Create a schedule in the webview editor. |
| `Agent Schedules: Edit` | Edit an existing schedule. |
| `Agent Schedules: Run Now` | Run a schedule immediately. |
| `Agent Schedules: Enable` | Enable a disabled schedule. |
| `Agent Schedules: Disable` | Disable an enabled schedule. |
| `Agent Schedules: View Run History` | View recorded schedule run history. |
| `Agent Schedules: View Active Workflow Runs` | Pick from active workflow runs. |
| `Agent Schedules: Inspect Workflow Run` | Show workflow run and step details. |
| `Agent Schedules: Open Workflow Run Folder` | Reveal a workflow run artifact folder. |
| `Agent Schedules: Cancel Workflow Run` | Cancel a cancellable workflow run. |
| `Agent Schedules: Start Agentic Workflow` | Prompt for a goal and start the agentic workflow bootstrap. |
| `Agent Schedules: Reload Commands` | Reload commands, skills, agents, and workflows. |
| `Agent Schedules: Test Execution` | Submit a quick test prompt to Cursor. |

The Agent Schedules tree appears in the Explorer view.

## Schedule Configuration

Schedules are stored in:

```text
.cursor/agent-schedules.json
```

The extension reads this file from the first workspace folder and merges user-specific enable/disable overrides from workspace state.

Example inline prompt schedule:

```json
{
  "version": "1.0",
  "schedules": [
    {
      "id": "daily-status",
      "name": "Daily Status",
      "enabled": false,
      "cron": "0 9 * * 1-5",
      "timezone": "America/Los_Angeles",
      "targetType": "prompt",
      "promptTemplate": "Create status-{date}.md with today's project status.",
      "executionMode": "ide",
      "outputConfig": {
        "type": "none"
      }
    }
  ]
}
```

Supported schedule targets:

- `prompt`: uses `promptTemplate`.
- `command`: uses `commandRef`.
- `skill`: uses `commandRef`.
- `agent`: uses `commandRef`.
- `workflow`: uses `workflowRef`.

Example workflow schedule:

```json
{
  "id": "workflow-smoke",
  "name": "Workflow Smoke Test",
  "enabled": false,
  "cron": "0 */4 * * *",
  "timezone": "America/Los_Angeles",
  "targetType": "workflow",
  "workflowRef": {
    "filePath": ".cursor/workflows/example-workflow.json",
    "workflowId": "example-workflow"
  },
  "executionMode": "ide",
  "outputConfig": {
    "type": "none"
  }
}
```

## Commands, Skills, And Agents

Command and agent files can be Markdown, JSON, YAML, or YML. Markdown files require an `id` in frontmatter. JSON and YAML files require `id` plus either `instructions` or `prompt`.

Example Markdown command:

```markdown
---
id: daily-report
description: Generate a daily status report
---

Create a short Markdown status report for {date}.
```

The extension scans these locations:

| Target | Default locations | Extra setting |
| --- | --- | --- |
| Commands | `.cursor/commands`, `~/.cursor/commands` | `cursorAgentFlow.additionalCommandDirectories` |
| Skills | `.cursor/skills`, `~/.cursor/skills-cursor` | `cursorAgentFlow.additionalSkillsDirectories` |
| Agents | `.cursor/agents`, `~/.cursor/agents` | `cursorAgentFlow.additionalAgentsDirectories` |
| MCP tool descriptors | Cursor's per-workspace MCP descriptor cache | `cursorAgentFlow.additionalMcpDirectories` |
| Workflows | `.cursor/workflows` | Not configurable |

Relative extra directories are resolved from the current process working directory. Absolute paths and `~` are also supported.

## Workflows

Workflows live in `.cursor/workflows/*.json`. Files ending in `.schema.json` are loaded as artifact schemas and are not treated as workflows.

Workflow runs are written to:

```text
.cursor/agent-runs/<run-id>/
```

Each run directory contains `workflow-run.json` plus any artifacts produced by the workflow.

Supported workflow step types:

| Step type | Purpose |
| --- | --- |
| `agent` | Submit a Cursor agent prompt and wait for an output artifact. |
| `readJson` | Read a JSON artifact, optionally validate it, and select a nested value. |
| `fanout` | Iterate over an array and run one or more child workflow steps for each item. |
| `join` | Collect matching artifact files and write a Markdown index. |
| `toolInventory` | Snapshot available commands, skills, agents, workflow primitives, and runtime actions. |
| `planRuntime` | Validate and execute a planner-produced `master-plan.json`. |

Workflow templates use double braces, for example `{{item.number}}`, `{{index}}`, `{{run.dir}}`, and `{{steps.scan.output}}`. Inline schedule prompt templates use single-brace date/time variables such as `{date}`.

Example workflow:

```json
{
  "id": "example-workflow",
  "name": "Example Workflow",
  "version": 1,
  "defaults": {
    "timeoutSeconds": 1800,
    "onStepFailure": "stop",
    "fanoutConcurrency": "sequential"
  },
  "steps": [
    {
      "id": "scan",
      "type": "agent",
      "name": "Scan for work",
      "input": {
        "title": "Scan for work",
        "freshChat": true,
        "submitMode": "worktree",
        "prompt": "Find items to process and write JSON to the required artifact path."
      },
      "output": {
        "path": "scan/items.json",
        "format": "json"
      }
    },
    {
      "id": "read-items",
      "type": "readJson",
      "input": {
        "path": "scan/items.json",
        "select": "items"
      }
    },
    {
      "id": "process-items",
      "type": "fanout",
      "input": {
        "itemsFrom": "steps.read-items.output",
        "step": {
          "id": "process-item",
          "type": "agent",
          "input": {
            "title": "Process {{item.id}}",
            "prompt": "Process item {{item.id}}."
          },
          "output": {
            "path": "items/{{item.id}}.md",
            "format": "markdown"
          }
        }
      }
    },
    {
      "id": "join-items",
      "type": "join",
      "input": {
        "from": "items/*.md",
        "outputPath": "summary/items.md"
      }
    }
  ]
}
```

Agent workflow steps append an output contract to the submitted prompt. The agent must write its complete result to the requested `.tmp` artifact path and then rename it to the final artifact path. If it cannot continue without human input, it can write a status artifact marking the step as blocked.

## Agentic Workflow MVP

The MVP agentic workflow is an ad-hoc workflow runtime layered on top of the static workflow engine. It is intended for local IDE execution.

Trigger it from the command palette:

```text
Agent Schedules: Start Agentic Workflow
```

The command prompts for a goal, creates an ad-hoc workflow schedule, and runs:

```text
.cursor/workflows/agentic-workflow-bootstrap.json
```

The bootstrap flow is:

```text
toolInventory -> planner -> planRuntime
```

- `toolInventory` writes `tool-inventory.json`.
- `planner` reads `.cursor/workflows/agentic-workflow-planner.md` and writes loose planner JSON to `plan/master-plan.json`.
- `planRuntime` validates the plan, writes authoritative state to `plan-run.json`, creates per-task input context, executes agent tasks, validates declared outputs, writes deterministic audit artifacts, and emits trace artifacts.

There is also a project skill wrapper:

```text
.cursor/skills/start-agentic-workflow/SKILL.md
```

Use it from Cursor chat when asking to start, trigger, or run an agentic workflow. If the chat agent cannot invoke VS Code commands directly, the skill instructs the user to run `Agent Schedules: Start Agentic Workflow` manually.

Agentic workflow runs write artifacts under:

```text
.cursor/agent-runs/<run-id>/
```

Important artifacts include:

| Artifact | Purpose |
| --- | --- |
| `tool-inventory.json` | Snapshot of available skills, agents, commands, workflow primitives, runtime actions, and advisory MCP tools. |
| `plan/master-plan.json` | Planner-authored master plan. |
| `plan/plan-validation.json` | Structured validation result for the master plan. |
| `plan-run.json` | Authoritative dynamic runtime state. |
| `tasks/<stage-id>/<task-id>/input-context.json` | Declaration-only memory and tool context for a task. |
| `tasks/<stage-id>/<task-id>/output.*` | Declared task output artifacts. |
| `tasks/<stage-id>/<task-id>/tool-use-evidence.json` | Required when a task selects advisory `mcp.*` tools; records the child agent's claimed MCP usage. |
| `audits/<stage-id>/<task-id>/audit.json` | Deterministic audit result used by the confidence gate. |
| `events.jsonl` | Append-only trace event log. |
| `trace.json` | Rebuildable trace index used by run inspection UI. |
| `artifact-lineage.json` | Rebuildable artifact lineage index. |
| `decision-log.md` | Human-readable decision timeline. |

Manual smoke test:

1. Open this repository in an Extension Development Host.
2. Run `Agent Schedules: Start Agentic Workflow`.
3. Enter a small goal, for example `Summarize today's git changes`.
4. Wait for the planner and runtime agent prompts to complete.
5. Open the Agent Schedules view and inspect the workflow run.
6. Open the run folder and verify `tool-inventory.json`, `plan/master-plan.json`, `plan-run.json`, `events.jsonl`, and `trace.json` exist.

MVP limitations:

- No crash resume.
- No automatic replanning or plan amendment application.
- MCP tools are advisory only: the child Cursor agent can use them, but the workflow runtime does not execute MCP calls itself.
- Confidence is deterministic pass/fail, not a numeric score.
- Cursor IDE agent tool usage is not directly observable, so trace events record runtime-selected tools and artifacts, not internal Cursor tool calls.
- Real end-to-end execution must be smoke-tested in a live Cursor extension host.

## Project Layout

```text
src/
  agent/       Cursor agent submission and local execution helpers
  commands/    command, skill, and agent registries
  execution/   schedule execution engine
  scheduler/   cron scheduling service
  storage/     schedule and run-history persistence
  ui/          tree views, webviews, and run detail views
  utils/       file, cron, and command parsing helpers
  workflow/    workflow registry, runner, step executors, and tests
```

## Notes And Limitations

- Local IDE execution is the implemented path. Cloud execution currently returns an unsupported error.
- Workflow execution is only supported in local IDE mode.
- Workflow fanout runs sequentially.
- The extension uses Cursor command IDs that may change across Cursor releases.
- Run history is stored in VS Code workspace state; workflow artifacts are stored on disk under `.cursor/agent-runs/`.

## License

MIT
