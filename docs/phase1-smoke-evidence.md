# Phase 1 Smoke Checklist

Phase 1 adds persisted per-task runtime artifacts, typed trace events, read-only Plan Run inspection, runtime policy hardening, and amendment-proposal blocking.

Status: live Extension Host smoke is still required before this phase should be treated as release-ready.

## Automated Evidence

- `pnpm exec tsc --noEmit`
- `node --test out/workflow/planRuntimeStepExecutor.test.js out/workflow/agentStepExecutor.test.js out/workflow/planValidator.test.js out/workflow/traceStore.test.js out/workflow/traceEvents.test.js out/ui/workflowRunTimeline.test.js out/ui/workflowRunDebugInfo.test.js out/ui/planRunModel.test.js`

## Required Manual Extension Host Evidence

Run these from an Extension Development Host before release:

1. Run `Cursor Agent Flow: Start Agentic Workflow` with a small goal.
2. Inspect the run and verify `plan-run.json`, `trace.json`, `artifact-lineage.json`, and per-task `prompt.md`, `task-prompt.md`, `validation.json`, and `provenance.json`.
3. Run `Cursor Agent Flow: Start Agentic Workflow From Plan Document` with a valid ready plan under `~/.cursor/plans/`.
4. Submit an invalid ready plan and verify it blocks before task execution.
5. Run or simulate a plan with advisory `mcp.*` tool selection and verify `tool-use-evidence.json` is required to advance.

When smoke is run, replace this section with dated evidence: Extension Host version, command used, run id, observed artifacts, and any failures. Do not treat this checklist as live evidence.
