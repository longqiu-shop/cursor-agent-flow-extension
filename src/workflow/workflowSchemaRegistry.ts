export interface SchemaValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: string[];
}

export type WorkflowSchemaValidator<T = unknown> = (value: unknown) => SchemaValidationResult<T>;

type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

interface JsonSchema {
  $id?: string;
  id?: string;
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  additionalProperties?: boolean;
}

export class WorkflowSchemaRegistry {
  private validators = new Map<string, WorkflowSchemaValidator>();
  private jsonSchemaIds = new Set<string>();

  register<T>(schemaId: string, validator: WorkflowSchemaValidator<T>): void {
    if (!schemaId || schemaId.trim().length === 0) {
      throw new Error('Workflow schema id is required');
    }
    this.validators.set(schemaId, validator as WorkflowSchemaValidator);
  }

  registerJsonSchema(schema: unknown, source = 'JSON schema'): SchemaValidationResult<string> {
    if (!isRecord(schema)) {
      return {
        valid: false,
        errors: [`${source} must be an object`]
      };
    }

    const schemaId = this.getJsonSchemaId(schema);
    if (!schemaId) {
      return {
        valid: false,
        errors: [`${source} must define a non-empty $id or id`]
      };
    }

    const validation = validateJsonSchemaDefinition(schema, source);
    if (!validation.valid) {
      return validation;
    }

    this.register(schemaId, value => validateJsonValue(value, schema as JsonSchema, schemaId));
    this.jsonSchemaIds.add(schemaId);

    return {
      valid: true,
      value: schemaId,
      errors: []
    };
  }

  clearJsonSchemas(): void {
    for (const schemaId of this.jsonSchemaIds) {
      this.validators.delete(schemaId);
    }
    this.jsonSchemaIds.clear();
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

  private getJsonSchemaId(schema: Record<string, unknown>): string | undefined {
    const id = typeof schema.$id === 'string' ? schema.$id : schema.id;
    return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
  }
}

function validateJsonSchemaDefinition(schema: Record<string, unknown>, source: string): SchemaValidationResult<string> {
  const errors: string[] = [];
  validateJsonSchemaNode(schema as JsonSchema, source, errors);
  return {
    valid: errors.length === 0,
    errors
  };
}

function validateJsonSchemaNode(schema: unknown, path: string, errors: string[]): void {
  if (!isRecord(schema)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const jsonSchema = schema as JsonSchema;

  if (jsonSchema.type !== undefined && !isValidSchemaType(jsonSchema.type)) {
    errors.push(`${path}.type is not supported`);
  }

  if (jsonSchema.properties !== undefined) {
    if (!isRecord(jsonSchema.properties)) {
      errors.push(`${path}.properties must be an object`);
    } else {
      for (const [propertyName, propertySchema] of Object.entries(jsonSchema.properties)) {
        validateJsonSchemaNode(propertySchema, `${path}.properties.${propertyName}`, errors);
      }
    }
  }

  if (jsonSchema.items !== undefined) {
    validateJsonSchemaNode(jsonSchema.items, `${path}.items`, errors);
  }
}

function isValidSchemaType(type: JsonSchema['type']): boolean {
  const validTypes = new Set<JsonSchemaType>(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (Array.isArray(type)) {
    return type.every(item => validTypes.has(item));
  }
  return Boolean(type && validTypes.has(type));
}

function validateJsonValue(value: unknown, schema: JsonSchema, schemaId: string, path = schemaId): SchemaValidationResult {
  const errors: string[] = [];
  validateValueAgainstSchema(value, schema, path, errors);
  return {
    valid: errors.length === 0,
    value: errors.length === 0 ? value : undefined,
    errors
  };
}

function validateValueAgainstSchema(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.enum !== undefined && !schema.enum.some(item => item === value)) {
    errors.push(`${path} must be one of: ${schema.enum.map(String).join(', ')}`);
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${formatType(schema.type)}`);
    return;
  }

  if (schema.type === 'object' || (schema.properties && isRecord(value))) {
    validateObjectValue(value, schema, path, errors);
  }

  if (schema.type === 'array' || (schema.items && Array.isArray(value))) {
    validateArrayValue(value, schema, path, errors);
  }

  if (typeof value === 'string') {
    validateStringValue(value, schema, path, errors);
  }

  if (typeof value === 'number') {
    validateNumberValue(value, schema, path, errors);
  }
}

function validateObjectValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    return;
  }

  for (const requiredProperty of schema.required ?? []) {
    if (value[requiredProperty] === undefined) {
      errors.push(`${path}.${requiredProperty} is required`);
    }
  }

  for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (value[propertyName] !== undefined) {
      validateValueAgainstSchema(value[propertyName], propertySchema, `${path}.${propertyName}`, errors);
    }
  }

  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const propertyName of Object.keys(value)) {
      if (!allowed.has(propertyName)) {
        errors.push(`${path}.${propertyName} is not allowed`);
      }
    }
  }
}

function validateArrayValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (!Array.isArray(value) || !schema.items) {
    return;
  }

  value.forEach((item, index) => {
    validateValueAgainstSchema(item, schema.items!, `${path}[${index}]`, errors);
  });
}

function validateStringValue(value: string, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path} must have length >= ${schema.minLength}`);
  }

  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} must match pattern ${schema.pattern}`);
  }
}

function validateNumberValue(value: number, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.type === 'integer' && !Number.isInteger(value)) {
    errors.push(`${path} must be integer`);
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
}

function matchesType(value: unknown, type: JsonSchema['type']): boolean {
  if (Array.isArray(type)) {
    return type.some(item => matchesType(value, item));
  }

  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function formatType(type: JsonSchema['type']): string {
  return Array.isArray(type) ? type.join(' or ') : String(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
