import type { JsonObject } from "./protocol.ts";
import type { ToolLike } from "./serializer.ts";

type JsonSchema = Record<string, unknown>;

export type ArgumentValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      errors: string[];
    };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaList(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function schemaTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((item): item is string => typeof item === "string");
  return [];
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateValue(schema: JsonSchema, value: unknown, path: string, errors: string[], maxErrors: number): void {
  if (errors.length >= maxErrors) return;

  const anyOf = schemaList(schema.anyOf);
  if (anyOf.length > 0) {
    if (!anyOf.some((item) => validateSubschema(item, value, path).ok)) {
      errors.push(`${path} does not match any allowed schema`);
    }
    return;
  }

  const oneOf = schemaList(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((item) => validateSubschema(item, value, path).ok).length;
    if (matches !== 1) errors.push(`${path} must match exactly one allowed schema`);
    return;
  }

  const allowedTypes = schemaTypes(schema);
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => schemaTypeMatches(value, type))) {
    errors.push(`${path} expected ${allowedTypes.join("|")}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEqual(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let index = 0; index < value.length && errors.length < maxErrors; index += 1) {
      validateValue(schema.items, value[index], `${path}[${index}]`, errors, maxErrors);
    }
    return;
  }

  if (isPlainObject(value)) {
    validateObjectSchema(schema, value, path, errors, maxErrors);
  }
}

function validateSubschema(schema: JsonSchema, value: unknown, path: string): ArgumentValidationResult {
  const errors: string[] = [];
  validateValue(schema, value, path, errors, 1);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateObjectSchema(
  schema: JsonSchema,
  value: JsonObject,
  path: string,
  errors: string[],
  maxErrors: number,
): void {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      errors.push(`${path}.${name} is required`);
      if (errors.length >= maxErrors) return;
    }
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [name, item] of Object.entries(value)) {
    const propertyPath = `${path}.${name}`;
    const propertySchema = properties[name];
    if (isPlainObject(propertySchema)) {
      validateValue(propertySchema, item, propertyPath, errors, maxErrors);
      if (errors.length >= maxErrors) return;
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(`${propertyPath} is not allowed by schema`);
      if (errors.length >= maxErrors) return;
    }
  }
}

export function validateToolArguments(
  tool: ToolLike | undefined,
  argumentsObject: JsonObject,
  maxErrors = 8,
): ArgumentValidationResult {
  if (!tool || !isPlainObject(tool.parameters)) return { ok: true };

  const schema = tool.parameters;
  const errors: string[] = [];
  validateValue(schema, argumentsObject, "arguments", errors, maxErrors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
