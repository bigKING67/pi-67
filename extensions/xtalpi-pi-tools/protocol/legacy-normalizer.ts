import type { JsonObject } from "../protocol.ts";
import type { ToolCallParseResult } from "./json-action-parser.ts";
import {
  parseJsonWithLikelyWindowsPathRepair,
  stripMarkdownFence,
} from "./windows-json-repair.ts";

const TOOL_NAME_ALIASES = ["name", "tool", "tool_name", "function_name"] as const;
const TOOL_ARGUMENT_ALIASES = ["arguments", "args", "input", "parameters", "arguments_json"] as const;
const TOOL_METADATA_FIELDS = ["id", "tool_call_id", "call_id", "type"] as const;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgumentObjectValue(
  value: unknown,
  rawForErrors: string,
): { value: JsonObject; rawJson: string; warnings: string[] } | ToolCallParseResult {
  if (isPlainObject(value)) {
    return {
      value,
      rawJson: JSON.stringify(value),
      warnings: [],
    };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {
        kind: "error",
        code: "invalid_arguments",
        message: '"arguments" string must contain a JSON object',
        raw: value,
        text: rawForErrors,
      };
    }

    try {
      const parsed = parseJsonWithLikelyWindowsPathRepair(trimmed);
      if (!isPlainObject(parsed.value)) {
        return {
          kind: "error",
          code: "invalid_arguments",
          message: '"arguments" must be a JSON object',
          raw: parsed.jsonText,
          text: rawForErrors,
        };
      }

      return {
        value: parsed.value,
        rawJson: parsed.jsonText,
        warnings: ["accepted JSON-string tool arguments", ...parsed.warnings],
      };
    } catch (error) {
      return {
        kind: "error",
        code: "invalid_json",
        message: error instanceof Error ? error.message : String(error),
        raw: value,
        text: rawForErrors,
      };
    }
  }

  return {
    kind: "error",
    code: "invalid_arguments",
    message: '"arguments" must be a JSON object',
    raw: rawForErrors,
    text: rawForErrors,
  };
}

export function parseLooseNameArgumentsEnvelope(
  raw: string,
  originalText: string,
): ToolCallParseResult | undefined {
  const cleaned = stripMarkdownFence(raw);
  const nameMatch = cleaned.match(/(?:^|\r?\n)\s*(name|tool|tool_name|function_name)\s*(?::|=)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+))\s*(?:\r?\n|$)/i);
  const argumentsMatch = cleaned.match(/(?:^|\r?\n)\s*(arguments(?:_json)?|args|input|parameters)\s*(?::|=)\s*([\s\S]+)$/i);
  if (!nameMatch || !argumentsMatch) return undefined;

  const nameField = nameMatch[1].toLowerCase();
  const name = (nameMatch[2] || nameMatch[3] || nameMatch[4] || "").trim();
  if (!name) {
    return {
      kind: "error",
      code: "invalid_name",
      message: '"name" must be a non-empty string',
      raw: cleaned,
      text: originalText,
    };
  }

  const argumentField = argumentsMatch[1].toLowerCase();
  const warnings = ["accepted loose name/arguments pi_tool_call body"];
  if (nameField !== "name") warnings.push(`accepted tool name alias "${nameField}"`);
  if (argumentField !== "arguments") warnings.push(`accepted tool arguments alias "${argumentField}"`);
  if (argumentField === "arguments_json") {
    warnings.push("accepted legacy arguments_json pi_tool_call field");
  }

  let parsedArgumentValue: unknown;
  try {
    const parsed = parseJsonWithLikelyWindowsPathRepair(argumentsMatch[2].trim());
    parsedArgumentValue = parsed.value;
    warnings.push(...parsed.warnings);
  } catch (error) {
    return {
      kind: "error",
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
      raw: cleaned,
      text: originalText,
    };
  }

  const parsedArguments = parseArgumentObjectValue(parsedArgumentValue, cleaned);
  if ("kind" in parsedArguments) return parsedArguments;
  warnings.push(...parsedArguments.warnings);

  return {
    kind: "tool_call",
    call: {
      name,
      arguments: parsedArguments.value,
    },
    before: "",
    after: "",
    rawJson: JSON.stringify({ name, arguments: parsedArguments.value }),
    warnings,
  };
}

function uniqueDefinedEntries(object: JsonObject, names: readonly string[]): Array<{ key: string; value: unknown }> {
  return names
    .filter((key) => Object.prototype.hasOwnProperty.call(object, key))
    .map((key) => ({ key, value: object[key] }));
}

function unknownFields(object: JsonObject, allowed: Iterable<string>): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(object).sort().filter((key) => !allowedSet.has(key));
}

export function toolLikeEnvelopeKeys(object: JsonObject): boolean {
  const keys = new Set(Object.keys(object));
  const hasName = TOOL_NAME_ALIASES.some((key) => keys.has(key));
  const hasArguments = TOOL_ARGUMENT_ALIASES.some((key) => keys.has(key));
  return (hasName && hasArguments) ||
    keys.has("tool_calls") ||
    keys.has("function_call") ||
    isPlainObject(object.function);
}

function errorUnknownTopLevelFields(
  fields: readonly string[],
  cleaned: string,
  originalText: string,
): ToolCallParseResult {
  return {
    kind: "error",
    code: "unknown_top_level_field",
    message: `unknown top-level field(s): ${fields.join(", ")}`,
    raw: cleaned,
    text: originalText,
  };
}

export function strictJsonActionFieldsError(
  parsed: JsonObject,
  allowed: readonly string[],
  cleaned: string,
  originalText: string,
): ToolCallParseResult {
  const unknown = unknownFields(parsed, allowed);
  if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
  return {
    kind: "error",
    code: "invalid_envelope",
    message: `JSON action envelope must contain exactly these fields: ${allowed.join(", ")}`,
    raw: cleaned,
    text: originalText,
  };
}

function normalizeNamedArgumentsObject(
  parsed: JsonObject,
  cleaned: string,
  originalText: string,
  baseWarnings: string[] = [],
): ToolCallParseResult {
  const metadataFields = new Set(TOOL_METADATA_FIELDS);
  const allowed = new Set([...TOOL_NAME_ALIASES, ...TOOL_ARGUMENT_ALIASES, ...metadataFields]);
  const keys = Object.keys(parsed).sort();
  const unknown = unknownFields(parsed, allowed);
  if (unknown.length > 0) {
    return errorUnknownTopLevelFields(unknown, cleaned, originalText);
  }

  const nameEntries = uniqueDefinedEntries(parsed, TOOL_NAME_ALIASES);
  if (nameEntries.length !== 1) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "tool envelope must contain exactly one tool name field",
      raw: cleaned,
      text: originalText,
    };
  }

  const rawName = nameEntries[0].value;
  if (typeof rawName !== "string" || rawName.trim() === "") {
    return {
      kind: "error",
      code: "invalid_name",
      message: '"name" must be a non-empty string',
      raw: cleaned,
      text: originalText,
    };
  }

  const argumentEntries = uniqueDefinedEntries(parsed, TOOL_ARGUMENT_ALIASES);
  if (argumentEntries.length !== 1) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "tool envelope must contain exactly one arguments field",
      raw: cleaned,
      text: originalText,
    };
  }

  const warnings = [...baseWarnings];
  if (nameEntries[0].key !== "name") warnings.push(`accepted tool name alias "${nameEntries[0].key}"`);
  if (argumentEntries[0].key !== "arguments") {
    warnings.push(`accepted tool arguments alias "${argumentEntries[0].key}"`);
  }
  if (keys.some((key) => metadataFields.has(key))) {
    warnings.push("accepted legacy tool-call metadata fields");
  }

  const parsedArguments = parseArgumentObjectValue(argumentEntries[0].value, cleaned);
  if ("kind" in parsedArguments) return parsedArguments;
  warnings.push(...parsedArguments.warnings);

  const name = rawName.trim();
  const args = parsedArguments.value;
  return {
    kind: "tool_call",
    call: { name, arguments: args },
    before: "",
    after: "",
    rawJson: JSON.stringify({ name, arguments: args }),
    warnings,
  };
}

function normalizeFunctionLikeObject(
  value: unknown,
  cleaned: string,
  originalText: string,
  baseWarnings: string[],
): ToolCallParseResult {
  if (!isPlainObject(value)) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "function-style tool envelope must be an object",
      raw: cleaned,
      text: originalText,
    };
  }

  return normalizeNamedArgumentsObject(value, cleaned, originalText, baseWarnings);
}

function normalizeOpenAiToolCallObject(
  value: unknown,
  cleaned: string,
  originalText: string,
  baseWarnings: string[],
): ToolCallParseResult {
  if (!isPlainObject(value)) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "tool_calls item must be an object",
      raw: cleaned,
      text: originalText,
    };
  }

  if (isPlainObject(value.function)) {
    const unknown = unknownFields(value, ["function", ...TOOL_METADATA_FIELDS]);
    if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
    if (Object.prototype.hasOwnProperty.call(value, "type") && value.type !== "function") {
      return {
        kind: "error",
        code: "invalid_envelope",
        message: 'tool_calls item type must be "function" when present',
        raw: cleaned,
        text: originalText,
      };
    }
    return normalizeFunctionLikeObject(value.function, cleaned, originalText, baseWarnings);
  }

  return normalizeNamedArgumentsObject(value, cleaned, originalText, baseWarnings);
}

export function normalizeParsedEnvelope(
  parsed: JsonObject,
  cleaned: string,
  originalText: string,
  warnings: string[],
): ToolCallParseResult {
  if (Object.prototype.hasOwnProperty.call(parsed, "kind")) {
    if (parsed.kind === "final") {
      const unknown = unknownFields(parsed, ["kind", "text"]);
      if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
      if (typeof parsed.text !== "string") {
        return {
          kind: "error",
          code: "invalid_envelope",
          message: 'JSON action envelope with kind "final" must contain string field "text"',
          raw: cleaned,
          text: originalText,
        };
      }
      return {
        kind: "none",
        text: parsed.text,
      };
    }

    if (parsed.kind === "tool_call") {
      const allowed = new Set(["kind", ...TOOL_NAME_ALIASES, ...TOOL_ARGUMENT_ALIASES, ...TOOL_METADATA_FIELDS]);
      const unknown = unknownFields(parsed, allowed);
      if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
      const withoutKind = { ...parsed };
      delete withoutKind.kind;
      return normalizeNamedArgumentsObject(withoutKind, cleaned, originalText, [
        ...warnings,
        "accepted JSON action tool_call envelope",
      ]);
    }

    return {
      kind: "error",
      code: "invalid_envelope",
      message: '"kind" must be either "tool_call" or "final" when present',
      raw: cleaned,
      text: originalText,
    };
  }

  if (Array.isArray(parsed.tool_calls)) {
    const unknown = unknownFields(parsed, ["tool_calls"]);
    if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
    if (parsed.tool_calls.length !== 1) {
      return {
        kind: "error",
        code: "multiple_tool_calls",
        message: `expected exactly one tool_calls item, got ${parsed.tool_calls.length}`,
        raw: cleaned,
        text: originalText,
      };
    }
    return normalizeOpenAiToolCallObject(parsed.tool_calls[0], cleaned, originalText, [
      ...warnings,
      "accepted text-native OpenAI tool_calls envelope",
    ]);
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "function_call")) {
    const unknown = unknownFields(parsed, ["function_call"]);
    if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
    return normalizeFunctionLikeObject(parsed.function_call, cleaned, originalText, [
      ...warnings,
      "accepted text-native function_call envelope",
    ]);
  }

  if (isPlainObject(parsed.function)) {
    const unknown = unknownFields(parsed, ["function"]);
    if (unknown.length > 0) return errorUnknownTopLevelFields(unknown, cleaned, originalText);
    return normalizeFunctionLikeObject(parsed.function, cleaned, originalText, [
      ...warnings,
      "accepted text-native function envelope",
    ]);
  }

  return normalizeNamedArgumentsObject(parsed, cleaned, originalText, warnings);
}
