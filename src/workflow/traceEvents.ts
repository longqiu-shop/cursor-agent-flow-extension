export const TRACE_EVENTS = {
  TRIGGER_RECEIVED: 'trigger.received',
  WORKFLOW_STARTED: 'workflow.started',
  TOOL_INVENTORY_CREATED: 'toolInventory.created',
  WORKFLOW_PREFERENCES_DISCOVERED: 'workflowPreferences.discovered',
  WORKFLOW_PREFERENCES_SELECTED: 'workflowPreferences.selected',
  WORKFLOW_PREFERENCES_RESOLVED: 'workflowPreferences.resolved',
  WORKFLOW_PREFERENCES_CONFLICT: 'workflowPreferences.conflict',
  PLAN_CREATED: 'plan.created',
  PLAN_VALIDATED: 'plan.validated',
  MEMORY_CONTEXT_CREATED: 'memoryContext.created',
  AGENT_PROMPTED: 'agent.prompted',
  TOOL_SELECTED: 'tool.selected',
  ARTIFACT_PRODUCED: 'artifact.produced',
  TASK_VALIDATED: 'task.validated',
  AUDIT_COMPLETED: 'audit.completed',
  STAGE_ADVANCED: 'stage.advanced',
  STAGE_BLOCKED: 'stage.blocked',
  MEMORY_PROPOSED: 'memory.proposed',
  MEMORY_COMMITTED: 'memory.committed',
  PLAN_AMENDMENT_PROPOSED: 'plan.amendmentProposed',
  PLAN_RUNTIME_BLOCKED: 'planRuntime.blocked'
} as const;

export type TraceEventType = typeof TRACE_EVENTS[keyof typeof TRACE_EVENTS];

const REQUIRED_REFS: Record<TraceEventType, string[]> = {
  [TRACE_EVENTS.TRIGGER_RECEIVED]: ['source'],
  [TRACE_EVENTS.WORKFLOW_STARTED]: ['runId'],
  [TRACE_EVENTS.TOOL_INVENTORY_CREATED]: ['artifacts'],
  [TRACE_EVENTS.WORKFLOW_PREFERENCES_DISCOVERED]: ['artifacts', 'preferenceIds'],
  [TRACE_EVENTS.WORKFLOW_PREFERENCES_SELECTED]: ['preferenceIds'],
  [TRACE_EVENTS.WORKFLOW_PREFERENCES_RESOLVED]: ['artifacts', 'preferenceIds'],
  [TRACE_EVENTS.WORKFLOW_PREFERENCES_CONFLICT]: ['artifacts', 'preferenceIds'],
  [TRACE_EVENTS.PLAN_CREATED]: ['artifacts'],
  [TRACE_EVENTS.PLAN_VALIDATED]: ['status', 'artifacts'],
  [TRACE_EVENTS.MEMORY_CONTEXT_CREATED]: ['stageId', 'taskId', 'artifacts'],
  [TRACE_EVENTS.AGENT_PROMPTED]: ['stageId', 'taskId', 'artifacts'],
  [TRACE_EVENTS.TOOL_SELECTED]: ['stageId', 'taskId', 'tools'],
  [TRACE_EVENTS.ARTIFACT_PRODUCED]: ['stageId', 'taskId', 'artifacts'],
  [TRACE_EVENTS.TASK_VALIDATED]: ['stageId', 'taskId', 'status', 'artifacts'],
  [TRACE_EVENTS.AUDIT_COMPLETED]: ['stageId', 'taskId', 'status', 'artifacts'],
  [TRACE_EVENTS.STAGE_ADVANCED]: ['stageId', 'status'],
  [TRACE_EVENTS.STAGE_BLOCKED]: ['stageId', 'reason'],
  [TRACE_EVENTS.MEMORY_PROPOSED]: ['stageId', 'taskId', 'artifacts'],
  [TRACE_EVENTS.MEMORY_COMMITTED]: ['scope', 'artifacts'],
  [TRACE_EVENTS.PLAN_AMENDMENT_PROPOSED]: ['stageId', 'taskId', 'artifacts'],
  [TRACE_EVENTS.PLAN_RUNTIME_BLOCKED]: ['reason']
};

export function requiredRefsForTraceEvent(type: TraceEventType): string[] {
  return [...REQUIRED_REFS[type]];
}

export function validateTraceEventRefs(type: TraceEventType, refs: Record<string, unknown>): string[] {
  return REQUIRED_REFS[type]
    .filter(key => refs[key] === undefined)
    .map(key => `Trace event ${type} requires ref "${key}"`);
}
