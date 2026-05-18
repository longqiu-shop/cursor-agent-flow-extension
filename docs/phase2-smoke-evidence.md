# Phase 2 Smoke Checklist

Phase 2 adds Workflow Preferences as planner context.

Status: live Extension Host smoke has not been recorded yet. This document is a release-readiness checklist, not live evidence.

## Automated Evidence

- `pnpm run compile`
- `pnpm test`
- `pnpm run coverage`

## Required Manual Extension Host Evidence

Run these from an Extension Development Host after Phase 2 implementation and before claiming release readiness:

1. Run `Cursor Agent Flow: Start Agentic Workflow` with a small goal and verify `preferences/workflow-preferences.json`, `tool-inventory.json`, `plan/master-plan.json`, `plan-run.json`, `events.jsonl`, and `trace.json`.
2. Add a project preference under `.cursor/agent-flow/preferences/`, rerun the command-palette start path, and verify `tool-inventory.json` contains a compact `workflowPreferences.*` entry and the planner prompt includes the preference artifact path.
3. Trigger the agent-chat request path with `start-agentic-workflow-YYYYMMDDHHmmss.json` and verify the same preference artifacts and trace events are produced.
4. Run `Cursor Agent Flow: Start Agentic Workflow From Plan Document` with a valid ready plan that declares `workflowPreferences.selectedPreferenceIds`, then verify the runtime validates the selected preference references against inventory.
5. Submit an invalid ready plan or a high-risk plan without required approval and verify the run blocks before task execution with `plan/plan-validation.json` and a `planRuntime.blocked` trace event.
6. Run or simulate an advisory MCP plan and verify selected `mcp.*` tool ids appear in the task prompt and `tool-use-evidence.json` is required for confidence to advance.

When smoke is run, replace this checklist with dated evidence: date/time, Extension Host version, command or request path used, run ids, observed artifacts, observed trace events, and failures. Until then, Phase 2 should not be described as having live smoke evidence.
