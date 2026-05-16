export type WorkflowVariables = Record<string, unknown>;

export class VariableResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariableResolutionError';
  }
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(template: string, variables: WorkflowVariables): string {
  return template.replace(VARIABLE_PATTERN, (_match, variablePath: string) => {
    const value = getVariable(variablePath, variables);
    if (value === undefined || value === null) {
      throw new VariableResolutionError(`Missing workflow variable: ${variablePath}`);
    }
    if (typeof value === 'object') {
      throw new VariableResolutionError(`Workflow variable ${variablePath} cannot render object values`);
    }
    return String(value);
  });
}

export function assertNoUnresolvedVariables(rendered: string): void {
  const match = VARIABLE_PATTERN.exec(rendered);
  VARIABLE_PATTERN.lastIndex = 0;
  if (match) {
    throw new VariableResolutionError(`Unresolved workflow variable: ${match[1]}`);
  }
}

export function getVariable(variablePath: string, variables: WorkflowVariables): unknown {
  const parts = variablePath.split('.');
  let current: unknown = variables;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
