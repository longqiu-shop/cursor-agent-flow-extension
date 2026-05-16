export interface SchemaValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: string[];
}

export type WorkflowSchemaValidator<T = unknown> = (value: unknown) => SchemaValidationResult<T>;

export class WorkflowSchemaRegistry {
  private validators = new Map<string, WorkflowSchemaValidator>();

  register<T>(schemaId: string, validator: WorkflowSchemaValidator<T>): void {
    if (!schemaId || schemaId.trim().length === 0) {
      throw new Error('Workflow schema id is required');
    }
    this.validators.set(schemaId, validator as WorkflowSchemaValidator);
  }

  validate(schemaId: string | undefined, value: unknown): SchemaValidationResult {
    if (!schemaId || schemaId === 'none') {
      return { valid: true, value, errors: [] };
    }

    const validator = this.validators.get(schemaId);
    if (!validator) {
      return {
        valid: false,
        errors: [`Unknown workflow artifact schema: ${schemaId}`]
      };
    }

    return validator(value);
  }

  has(schemaId: string): boolean {
    return this.validators.has(schemaId);
  }
}
