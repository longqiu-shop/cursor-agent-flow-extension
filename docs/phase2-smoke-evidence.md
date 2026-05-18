# Phase 2 Smoke Evidence

Phase 2 adds Workflow Preferences as planner context.

Status: live Extension Host smoke evidence recorded on 2026-05-18. The required validation paths passed after the reliability fixes listed below.

## Automated Evidence

- `pnpm test` passed during Phase 2 reliability validation: 159/159 tests, with the existing 19 lint warnings.
- `pnpm run compile && node --test out/workflow/outputContractManager.test.js out/workflow/planRuntimeStepExecutor.test.js` passed for the `submission-debug.json` runtime-artifact fix.
- `pnpm run compile && node --test out/execution/executionEngine.test.js` passed for the Composer readiness wait fix.
- Scoped ESLint passed for files changed in the follow-up reliability fixes.

## Manual Extension Host Evidence

### Agent-Chat Trigger Path

- Date/time: 2026-05-18 11:55-12:07 UTC.
- Trigger path: agent-chat request file, `start-agentic-workflow-20260518115526`.
- Run ID: `run_1779130538520_11a7f1ab-1a1d-4dc2-8880-ca6f3ecb12eb`.
- Run directory: `.cursor/agent-runs/run_1779130538520_11a7f1ab-1a1d-4dc2-8880-ca6f3ecb12eb`.
- Result: `workflow-run.json` status `succeeded`; `plan-run.json` status `succeeded`.
- Observed artifacts: `preferences/workflow-preferences.json`, `tool-inventory.json`, `plan/master-plan.json`, `plan/plan-validation.json`, `plan-run.json`, `events.jsonl`, `trace.json`, task outputs under `tasks/execute/candidate-review`, `tasks/execute/verify-findings`, and `tasks/execute/synthesize-review`.
- Observed trace events: `workflowPreferences.discovered`, `workflowPreferences.resolved`, `workflowPreferences.selected`, `plan.validated`, `task.started`, `agentSubmission.queued`, `agentSubmission.submitted`, `agentSubmission.artifactFound`, `task.validated`, `audit.completed`, `stage.completed`, `planRuntime.completed`.

### Project Preference Discovery And Selection

- Date/time: 2026-05-18.
- Project preference file: `.cursor/agent-flow/preferences/pr-review-flow.md`.
- Preference ID: `pr-review-flow`.
- Evidence runs:
  - `run_1779084965554_88b6e98f-75ce-400b-bdc5-53b7846a2aec`, agent-chat PR review using the project PR review workflow preference, status `succeeded`.
  - `run_1779125571468_651c291f-c952-4ef7-ae87-e2950ee39f3d`, ready-plan validation selecting `pr-review-flow`, status `succeeded`.
- Observed artifacts: `preferences/workflow-preferences.json` contained `pr-review-flow`; `tool-inventory.json` contained `workflowPreferences.pr-review-flow`; `plan/master-plan.json` selected `workflowPreferences.selectedPreferenceIds: ["pr-review-flow"]`.
- Observed trace events: `workflowPreferences.discovered`, `workflowPreferences.resolved`, `workflowPreferences.selected`.

### Ready-Plan Valid Preference Path

- Date/time: 2026-05-18 17:32 UTC.
- Trigger path: `Cursor Agent Flow: Start Agentic Workflow From Plan Document`.
- Plan document: `~/.cursor/plans/phase2-ready-plan.md`.
- Run ID: `run_1779125571468_651c291f-c952-4ef7-ae87-e2950ee39f3d`.
- Run directory: `.cursor/agent-runs/run_1779125571468_651c291f-c952-4ef7-ae87-e2950ee39f3d`.
- Result: `workflow-run.json` status `succeeded`; `plan-run.json` status `succeeded`.
- Observed artifacts: `plan/import-validation.json` valid, `plan/plan-validation.json` valid, `tool-inventory.json`, `plan/master-plan.json`, `tasks/execute/summarize-ready-plan/output.md`, `tasks/execute/summarize-ready-plan/validation.json`, `tasks/execute/summarize-ready-plan/submission-debug.json`.
- Observed trace events: `plan.validated` with status `passed`, `workflowPreferences.selected` with `pr-review-flow`, `agentSubmission.artifactFound`, `task.validated` with status `passed`.

### Invalid Preference Block

- Date/time: 2026-05-18 18:13 UTC.
- Trigger path: `Cursor Agent Flow: Start Agentic Workflow From Plan Document`.
- Plan document: `~/.cursor/plans/phase2-invalid-preference-plan.md`.
- Run ID: `run_1779128011140_862d7d99-e814-4905-8f66-fa06a43122db`.
- Run directory: `.cursor/agent-runs/run_1779128011140_862d7d99-e814-4905-8f66-fa06a43122db`.
- Result: `plan-run.json` status `blocked`.
- Block reason: `Plan references unknown workflow preference: missing-preference`.
- Observed artifacts: `plan/import-validation.json` valid, `plan/plan-validation.json` invalid with `UNKNOWN_WORKFLOW_PREFERENCE`, `plan-run.json`, `events.jsonl`, `trace.json`.
- Observed trace events: `plan.validated` with status `failed`, `planRuntime.blocked`.
- Task execution: no task artifacts were produced; `should-not-run` did not start.

### High-Risk Block

- Date/time: 2026-05-18 18:23 UTC.
- Trigger path: `Cursor Agent Flow: Start Agentic Workflow From Plan Document`.
- Plan document: `~/.cursor/plans/phase2-high-risk-plan.md`.
- Run ID: `run_1779128588600_8d537e8b-4377-48ed-8ac0-198e6c698a6b`.
- Run directory: `.cursor/agent-runs/run_1779128588600_8d537e8b-4377-48ed-8ac0-198e6c698a6b`.
- Result: `plan-run.json` status `blocked`.
- Block reason: `High-risk plans require requiresApproval: true before execution`.
- Observed artifacts: `plan/import-validation.json` valid, `plan/plan-validation.json` invalid with `HIGH_RISK_REQUIRES_APPROVAL`, `plan-run.json`, `events.jsonl`, `trace.json`.
- Observed trace events: `plan.validated` with status `failed`, `planRuntime.blocked`.
- Task execution: no task artifacts were produced; `high-risk-should-not-run` did not start.

### Advisory MCP Evidence

- Date/time: 2026-05-18 23:07-23:09 UTC.
- Trigger path: `Cursor Agent Flow: Start Agentic Workflow From Plan Document`.
- Plan document: `~/.cursor/plans/phase2-mcp-evidence-plan.md`.
- Run ID: `run_1779145643677_55683e90-e639-40d6-a592-4d31064709c0`.
- Run directory: `.cursor/agent-runs/run_1779145643677_55683e90-e639-40d6-a592-4d31064709c0`.
- Result: `workflow-run.json` status `succeeded`; `plan-run.json` status `succeeded`.
- Observed artifacts: `plan/import-validation.json` valid, `plan/plan-validation.json` valid, `tasks/execute/mcp-evidence/output.md`, `tasks/execute/mcp-evidence/tool-use-evidence.json`, `tasks/execute/mcp-evidence/validation.json`, `audits/execute/mcp-evidence/audit.json`, `events.jsonl`, `trace.json`.
- Prompt evidence: `tasks/execute/mcp-evidence/task-prompt.md` and `prompt.md` included `mcp.user-github.search_pull_requests` and required `tool-use-evidence.json` with schema `tool-use-evidence@1`.
- Validation evidence: `tasks/execute/mcp-evidence/validation.json` had `valid: true`, empty `missingEvidence`, and empty `risks`.
- Audit evidence: `audits/execute/mcp-evidence/audit.json` had `nextAction: "advance"`.
- Observed trace events: `tool.selected` included `mcp.user-github.search_pull_requests`; `task.validated` status `passed`; `audit.completed` status `advance`; `artifact.produced` included `tool-use-evidence.json`; `planRuntime.completed` status `succeeded`.
- Note: the evidence artifact recorded that the `user-github` MCP binding was not exposed in that Cursor session, so no live GitHub search was executed. This smoke still validated advisory MCP tool selection, prompt inclusion, required evidence shape, and runtime evidence gating.

## Reliability Findings During Smoke

- Interleaved workflow/agent submissions caused confusing task progression and timeouts. Fixed by PR #24, which serializes the full agent submission lifecycle through artifact/status detection and adds submission correlation debug artifacts.
- `submission-debug.json` was initially treated as an unexpected task output. Fixed by PR #26, which registers it as a runtime-owned task artifact and allowlists it in plan runtime output validation.
- Cursor sometimes opened a Composer chat without sending automatically. Mitigated by PR #28, which increases the readiness wait after `workbench.action.chat.open` before triggering the Composer send/worktree command.

## Release Readiness Summary

Phase 2 live Extension Host smoke evidence is recorded for workflow preferences, project preference selection, ready-plan validation, invalid/high-risk blocking, agent-chat trigger execution, and advisory MCP evidence enforcement. Known reliability regressions discovered during smoke were fixed in PR #24, PR #26, and PR #28.
