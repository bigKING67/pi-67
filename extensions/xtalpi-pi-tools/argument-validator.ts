import type { JsonObject } from "./protocol.ts";
import { jsonDeepEqual } from "./json-utils.ts";
import type { ToolLike } from "./tools/types.ts";

type JsonSchema = Record<string, unknown>;

const MAX_PATTERN_CHARS = 256;
const MAX_PATTERN_INPUT_CHARS = 1024;
const NESTED_QUANTIFIER_PATTERN = new RegExp(
  String.raw`\((?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})`,
);

export type ArgumentValidationWarningCode =
  | "pattern_too_long"
  | "pattern_input_too_long"
  | "pattern_nested_quantifier"
  | "pattern_invalid_regex";

export type ArgumentValidationWarning = {
  code: ArgumentValidationWarningCode;
  path: string;
  patternChars?: number;
  inputChars?: number;
};

export type ArgumentValidationResult =
  | {
      ok: true;
      warnings: ArgumentValidationWarning[];
    }
  | {
      ok: false;
      errors: string[];
      warnings: ArgumentValidationWarning[];
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

function numericKeyword(schema: JsonSchema, name: string): number | undefined {
  const value = schema[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerKeyword(schema: JsonSchema, name: string): number | undefined {
  const value = numericKeyword(schema, name);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function validationLimit(value: number, fallback: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function pushError(errors: string[], maxErrors: number, message: string): void {
  if (errors.length < maxErrors) errors.push(message);
}

function pushWarning(
  warnings: ArgumentValidationWarning[],
  maxWarnings: number,
  warning: ArgumentValidationWarning,
): void {
  if (warnings.length < maxWarnings) warnings.push(warning);
}

function pushWarnings(
  warnings: ArgumentValidationWarning[],
  maxWarnings: number,
  nextWarnings: readonly ArgumentValidationWarning[],
): void {
  for (const warning of nextWarnings) {
    pushWarning(warnings, maxWarnings, warning);
    if (warnings.length >= maxWarnings) return;
  }
}

function patternSkipReason(pattern: string, value: string): ArgumentValidationWarningCode | undefined {
  if (pattern.length > MAX_PATTERN_CHARS) return "pattern_too_long";
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) return "pattern_nested_quantifier";
  if (value.length > MAX_PATTERN_INPUT_CHARS) return "pattern_input_too_long";
  return undefined;
}

function validateNumberConstraints(schema: JsonSchema, value: number, path: string, errors: string[], maxErrors: number): void {
  const minimum = numericKeyword(schema, "minimum");
  const maximum = numericKeyword(schema, "maximum");
  const exclusiveMinimum = schema.exclusiveMinimum;
  const exclusiveMaximum = schema.exclusiveMaximum;
  const multipleOf = numericKeyword(schema, "multipleOf");

  if (typeof exclusiveMinimum === "number" && Number.isFinite(exclusiveMinimum)) {
    if (!(value > exclusiveMinimum)) pushError(errors, maxErrors, `${path} must be > ${exclusiveMinimum}`);
  } else if (minimum !== undefined) {
    const exclusive = exclusiveMinimum === true;
    if (exclusive ? !(value > minimum) : value < minimum) {
      pushError(errors, maxErrors, `${path} must be ${exclusive ? ">" : ">="} ${minimum}`);
    }
  }

  if (errors.length >= maxErrors) return;

  if (typeof exclusiveMaximum === "number" && Number.isFinite(exclusiveMaximum)) {
    if (!(value < exclusiveMaximum)) pushError(errors, maxErrors, `${path} must be < ${exclusiveMaximum}`);
  } else if (maximum !== undefined) {
    const exclusive = exclusiveMaximum === true;
    if (exclusive ? !(value < maximum) : value > maximum) {
      pushError(errors, maxErrors, `${path} must be ${exclusive ? "<" : "<="} ${maximum}`);
    }
  }

  if (errors.length >= maxErrors) return;

  if (multipleOf !== undefined && multipleOf > 0) {
    const ratio = value / multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > Number.EPSILON * 100) {
      pushError(errors, maxErrors, `${path} must be a multiple of ${multipleOf}`);
    }
  }
}

function validateStringConstraints(
  schema: JsonSchema,
  value: string,
  path: string,
  errors: string[],
  maxErrors: number,
  warnings: ArgumentValidationWarning[],
  maxWarnings: number,
): void {
  const minLength = integerKeyword(schema, "minLength");
  const maxLength = integerKeyword(schema, "maxLength");

  if (minLength !== undefined && value.length < minLength) {
    pushError(errors, maxErrors, `${path} length must be >= ${minLength}`);
  }
  if (errors.length >= maxErrors) return;

  if (maxLength !== undefined && value.length > maxLength) {
    pushError(errors, maxErrors, `${path} length must be <= ${maxLength}`);
  }
  if (errors.length >= maxErrors) return;

  if (typeof schema.pattern === "string") {
    const skipReason = patternSkipReason(schema.pattern, value);
    if (skipReason) {
      pushWarning(warnings, maxWarnings, {
        code: skipReason,
        path,
        patternChars: schema.pattern.length,
        inputChars: value.length,
      });
      return;
    }

    try {
      if (!new RegExp(schema.pattern).test(value)) {
        pushError(errors, maxErrors, `${path} must match pattern ${schema.pattern}`);
      }
    } catch {
      pushWarning(warnings, maxWarnings, {
        code: "pattern_invalid_regex",
        path,
        patternChars: schema.pattern.length,
        inputChars: value.length,
      });
    }
  }
}

function validateArrayConstraints(schema: JsonSchema, value: unknown[], path: string, errors: string[], maxErrors: number): void {
  const minItems = integerKeyword(schema, "minItems");
  const maxItems = integerKeyword(schema, "maxItems");

  if (minItems !== undefined && value.length < minItems) {
    pushError(errors, maxErrors, `${path} must contain at least ${minItems} item(s)`);
  }
  if (errors.length >= maxErrors) return;

  if (maxItems !== undefined && value.length > maxItems) {
    pushError(errors, maxErrors, `${path} must contain at most ${maxItems} item(s)`);
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  maxErrors: number,
  warnings: ArgumentValidationWarning[],
  maxWarnings: number,
): void {
  if (errors.length >= maxErrors) return;

  const anyOf = schemaList(schema.anyOf);
  if (anyOf.length > 0) {
    let match: ArgumentValidationResult | undefined;
    for (const item of anyOf) {
      const result = validateSubschema(item, value, path, maxWarnings);
      if (result.ok) {
        match = result;
        break;
      }
    }
    if (!match) {
      errors.push(`${path} does not match any allowed schema`);
    } else {
      pushWarnings(warnings, maxWarnings, match.warnings);
    }
    return;
  }

  const oneOf = schemaList(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.map((item) => validateSubschema(item, value, path, maxWarnings)).filter((item) => item.ok);
    const match = matches.at(0);
    if (matches.length !== 1 || !match) {
      errors.push(`${path} must match exactly one allowed schema`);
    } else {
      pushWarnings(warnings, maxWarnings, match.warnings);
    }
    return;
  }

  const allowedTypes = schemaTypes(schema);
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => schemaTypeMatches(value, type))) {
    errors.push(`${path} expected ${allowedTypes.join("|")}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonDeepEqual(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  if (typeof value === "string") {
    validateStringConstraints(schema, value, path, errors, maxErrors, warnings, maxWarnings);
    if (errors.length >= maxErrors) return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    validateNumberConstraints(schema, value, path, errors, maxErrors);
    if (errors.length >= maxErrors) return;
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    validateArrayConstraints(schema, value, path, errors, maxErrors);
    if (errors.length >= maxErrors) return;
    for (let index = 0; index < value.length && errors.length < maxErrors; index += 1) {
      validateValue(schema.items, value[index], `${path}[${index}]`, errors, maxErrors, warnings, maxWarnings);
    }
    return;
  }

  if (Array.isArray(value)) {
    validateArrayConstraints(schema, value, path, errors, maxErrors);
    return;
  }

  if (isPlainObject(value)) {
    validateObjectSchema(schema, value, path, errors, maxErrors, warnings, maxWarnings);
  }
}

function validateSubschema(
  schema: JsonSchema,
  value: unknown,
  path: string,
  maxWarnings: number,
): ArgumentValidationResult {
  const errors: string[] = [];
  const warnings: ArgumentValidationWarning[] = [];
  validateValue(schema, value, path, errors, 1, warnings, maxWarnings);
  return errors.length === 0 ? { ok: true, warnings } : { ok: false, errors, warnings };
}

function validateObjectSchema(
  schema: JsonSchema,
  value: JsonObject,
  path: string,
  errors: string[],
  maxErrors: number,
  warnings: ArgumentValidationWarning[],
  maxWarnings: number,
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
      validateValue(propertySchema, item, propertyPath, errors, maxErrors, warnings, maxWarnings);
      if (errors.length >= maxErrors) return;
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(`${propertyPath} is not allowed by schema`);
      if (errors.length >= maxErrors) return;
    }
  }

  const minProperties = integerKeyword(schema, "minProperties");
  if (minProperties !== undefined && Object.keys(value).length < minProperties) {
    errors.push(`${path} must contain at least ${minProperties} propert${minProperties === 1 ? "y" : "ies"}`);
    if (errors.length >= maxErrors) return;
  }

  const maxProperties = integerKeyword(schema, "maxProperties");
  if (maxProperties !== undefined && Object.keys(value).length > maxProperties) {
    errors.push(`${path} must contain at most ${maxProperties} propert${maxProperties === 1 ? "y" : "ies"}`);
  }
}

export function validateToolArguments(
  tool: ToolLike | undefined,
  argumentsObject: JsonObject,
  maxErrors = 8,
  maxWarnings = 8,
): ArgumentValidationResult {
  if (!tool || !isPlainObject(tool.parameters)) return { ok: true, warnings: [] };

  const schema = tool.parameters;
  const errors: string[] = [];
  const warnings: ArgumentValidationWarning[] = [];
  const errorLimit = validationLimit(maxErrors, 8, 1);
  const warningLimit = validationLimit(maxWarnings, 8, 0);
  validateValue(schema, argumentsObject, "arguments", errors, errorLimit, warnings, warningLimit);
  return errors.length === 0 ? { ok: true, warnings } : { ok: false, errors, warnings };
}
