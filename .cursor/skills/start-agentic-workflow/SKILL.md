---
name: start-agentic-workflow
description: Starts the project agentic workflow runtime from chat by guiding invocation of the Agent Schedules start command. Use when the user asks to start, trigger, run, or kick off an agentic workflow, planner workflow, master-plan workflow, or workflow runtime from Cursor chat.
---

# Start Agentic Workflow

## Description

Starts the project agentic workflow runtime from chat by routing the user's goal through the extension command bridge.

## Instructions

Use this skill when the user wants to trigger the agentic workflow runtime from Cursor chat.

1. Confirm or infer the user's workflow goal in one short sentence.
2. Trigger the VS Code command `agentSchedules.startAgenticWorkflow` if command invocation is available.
3. If command invocation is not available, tell the user to run Command Palette -> `Agent Schedules: Start Agentic Workflow` and paste the goal when prompted.
4. After the command starts, the extension runs `.cursor/workflows/agentic-workflow-bootstrap.json`.
5. The expected runtime flow is `toolInventory -> planner -> planRuntime`.
6. To inspect the result, use the Agent Schedules view, open the workflow run details, or open the run folder under `.cursor/agent-runs/`.

Do not manually create `master-plan.json` unless the user explicitly asks for a fixture or debugging help. The planner step owns that artifact during a normal run.
