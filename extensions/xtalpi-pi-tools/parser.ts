import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  type JsonObject,
  type PiToolCallEnvelope,
} from "./protocol.ts";

export type ToolCallParseResult =
  | {
      kind: "none";
      text: string;
    }
  | {
      kind: "tool_call";
      call: PiToolCallEnvelope;
      before: string;
      after: string;
      rawJson: string;
      warnings: string[];
    }
  | {
      kind: "error";
      code:
        | "function_style_tool_call"
        | "multiple_tool_calls"
        | "invalid_json"
        | "invalid_envelope"
        | "invalid_name"
        | "invalid_arguments"
        | "raw_protocol_markup"
        | "unknown_top_level_field";
      message: string;
      raw: string;
      text: string;
    };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function hasEvenBackslashPrefix(value: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 0;
}

function escapeLikelyWindowsPathStringContent(value: string): { text: string; changed: boolean } {
  if (!/[A-Za-z]:\\/.test(value)) return { text: value, changed: false };

  let changed = false;
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      text += char;
      continue;
    }

    if (value[index + 1] === "\\") {
      text += "\\\\";
      index += 1;
    } else {
      text += "\\\\";
      changed = true;
    }
  }

  return { text, changed };
}

function escapeLikelyWindowsPathBackslashesInJsonStrings(value: string): { text: string; changed: boolean } {
  let changed = false;
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '"') {
      text += char;
      continue;
    }

    let content = "";
    let end = index + 1;
    for (; end < value.length; end += 1) {
      const inner = value[end];
      if (inner === '"' && hasEvenBackslashPrefix(value, end)) break;
      content += inner;
    }
    if (end >= value.length) {
      text += `"${content}`;
      index = value.length;
      break;
    }

    const repaired = escapeLikelyWindowsPathStringContent(content);
    text += `"${repaired.text}"`;
    changed = changed || repaired.changed;
    index = end;
  }

  return { text, changed };
}

function parseJsonWithLikelyWindowsPathRepair(raw: string): { value: unknown; jsonText: string; warnings: string[] } {
  const cleaned = stripMarkdownFence(raw);
  const repaired = escapeLikelyWindowsPathBackslashesInJsonStrings(cleaned);
  const candidate = repaired.changed ? repaired.text : cleaned;
  return {
    value: JSON.parse(candidate),
    jsonText: candidate,
    warnings: repaired.changed ? ["repaired likely Windows path backslashes in JSON strings"] : [],
  };
}

const TOOL_NAME_ALIASES = ["name", "tool", "tool_name", "function_name"] as const;
const TOOL_ARGUMENT_ALIASES = ["arguments", "args", "input", "parameters", "arguments_json"] as const;
const TOOL_METADATA_FIELDS = ["id", "tool_call_id", "call_id", "type"] as const;

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

function parseLooseNameArgumentsEnvelope(raw: string, originalText: string): ToolCallParseResult | undefined {
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

function detectFunctionStyleToolCall(value: string): { name: string; raw: string } | undefined {
  const trimmed = stripMarkdownFence(value).replace(/^`([\s\S]*)`$/, "$1").trim();
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/);
  if (!match) return undefined;

  const name = match[1];
  const args = match[2].trim();
  if (!args.startsWith("{") || !args.endsWith("}")) return undefined;

  return { name, raw: `${name}(${args})` };
}

const RAW_PROTOCOL_MARKUP_PATTERN =
  /(?:<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|<\/?tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|<\/?previous_pi_tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[\/?previous_pi_tool_call\])/i;

function containsRawProtocolMarkup(value: string): boolean {
  return RAW_PROTOCOL_MARKUP_PATTERN.test(value);
}

const PREVIOUS_TOOL_CALL_HISTORY_BLOCK_PATTERN =
  /(?:\[previous_pi_tool_call\]|<previous_pi_tool_call\b[^>]*>)[\s\S]*?(?:\[\/previous_pi_tool_call\]|<\/previous_pi_tool_call>)/gi;

function stripPreviousToolCallHistoryBlocks(value: string): string {
  return value
    .replace(PREVIOUS_TOOL_CALL_HISTORY_BLOCK_PATTERN, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function toolLikeEnvelopeKeys(object: JsonObject): boolean {
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
      message: 'tool envelope must contain exactly one tool name field',
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
      message: 'tool envelope must contain exactly one arguments field',
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

function normalizeParsedEnvelope(parsed: JsonObject, cleaned: string, originalText: string, warnings: string[]): ToolCallParseResult {
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

function parseEnvelope(raw: string, originalText: string): ToolCallParseResult {
  let cleaned = stripMarkdownFence(raw);
  let parsed: unknown;
  let warnings: string[] = [];

  try {
    const parsedJson = parseJsonWithLikelyWindowsPathRepair(cleaned);
    parsed = parsedJson.value;
    cleaned = parsedJson.jsonText;
    warnings = parsedJson.warnings;
  } catch (error) {
    const loose = parseLooseNameArgumentsEnvelope(raw, originalText);
    if (loose) return loose;
    return {
      kind: "error",
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
      raw: cleaned,
      text: originalText,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "tool envelope JSON must be an object",
      raw: cleaned,
      text: originalText,
    };
  }

  return normalizeParsedEnvelope(parsed, cleaned, originalText, warnings);
}

function parseAttributedEnvelope(openTag: string, raw: string, originalText: string): ToolCallParseResult {
  const nameMatch = openTag.match(/\sname=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
  if (!nameMatch) return parseEnvelope(raw, originalText);

  let cleaned = stripMarkdownFence(raw);
  let parsed: unknown;
  let warnings: string[] = ["accepted attributed pi_tool_call tag"];

  try {
    const parsedJson = parseJsonWithLikelyWindowsPathRepair(cleaned);
    parsed = parsedJson.value;
    cleaned = parsedJson.jsonText;
    warnings.push(...parsedJson.warnings);
  } catch (error) {
    return {
      kind: "error",
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
      raw: cleaned,
      text: originalText,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: "error",
      code: "invalid_arguments",
      message: "attributed tool-call tag body must be a JSON object of arguments",
      raw: cleaned,
      text: originalText,
    };
  }

  const name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || "").trim();
  if (!name) {
    return {
      kind: "error",
      code: "invalid_name",
      message: 'tool-call tag attribute "name" must be a non-empty string',
      raw: cleaned,
      text: originalText,
    };
  }

  if (toolLikeEnvelopeKeys(parsed)) {
    const nested = normalizeParsedEnvelope(parsed, cleaned, originalText, [
      ...warnings,
      "accepted nested envelope inside attributed tool-call tag",
    ]);
    if (nested.kind !== "tool_call") return nested;
    if (nested.call.name !== name) {
      return {
        kind: "error",
        code: "invalid_name",
        message: `attributed tool name "${name}" does not match nested envelope name "${nested.call.name}"`,
        raw: cleaned,
        text: originalText,
      };
    }
    return {
      ...nested,
      warnings: [...nested.warnings, "accepted attributed pi_tool_call tag"],
    };
  }

  return {
    kind: "tool_call",
    call: {
      name,
      arguments: parsed,
    },
    before: "",
    after: "",
    rawJson: cleaned,
    warnings,
  };
}

function findTaggedToolCalls(text: string): Array<{ start: number; end: number; body: string; openTag: string }> {
  const results: Array<{ start: number; end: number; body: string; openTag: string }> = [];
  const openTagPattern = /<(pi_tool_call|tool_call)(?:\s+[^>]*)?>/gi;

  for (let match = openTagPattern.exec(text); match; match = openTagPattern.exec(text)) {
    const start = match.index;
    const openTag = match[0];
    const closeTagPattern = new RegExp(`</${match[1]}>`, "i");
    const bodyStart = start + openTag.length;
    const closeMatch = closeTagPattern.exec(text.slice(bodyStart));
    if (!closeMatch) {
      results.push({ start, end: text.length, body: text.slice(bodyStart), openTag });
      break;
    }
    const close = bodyStart + closeMatch.index;
    const end = close + closeMatch[0].length;
    results.push({ start, end, body: text.slice(bodyStart, close), openTag });
    openTagPattern.lastIndex = end;
  }

  return results;
}

export function parseToolCall(text: string): ToolCallParseResult {
  const source = String(text ?? "");
  const taggedCalls = findTaggedToolCalls(source);

  if (taggedCalls.length > 1) {
    return {
      kind: "error",
      code: "multiple_tool_calls",
      message: `expected at most one ${TOOL_CALL_OPEN} envelope, got ${taggedCalls.length}`,
      raw: taggedCalls.map((item) => item.body.trim()).join("\n---\n"),
      text: source,
    };
  }

  if (taggedCalls.length === 1) {
    const tagged = taggedCalls[0];
    const parsed = parseAttributedEnvelope(tagged.openTag, tagged.body, source);
    if (parsed.kind !== "tool_call") return parsed;

    const before = stripPreviousToolCallHistoryBlocks(source.slice(0, tagged.start));
    const after = stripPreviousToolCallHistoryBlocks(source.slice(tagged.end));
    const warnings = [...parsed.warnings];
    if (before || after) {
      warnings.push("tool envelope had surrounding text");
    }
    if (before !== source.slice(0, tagged.start).trim() || after !== source.slice(tagged.end).trim()) {
      warnings.push("stripped previous_pi_tool_call history from surrounding text");
    }

    return {
      ...parsed,
      before,
      after,
      warnings,
    };
  }

  const bare = stripMarkdownFence(source);
  if (bare.startsWith("{") && bare.endsWith("}")) {
    const parsed = parseEnvelope(bare, source);
    if (parsed.kind === "tool_call") {
      return {
        ...parsed,
        warnings: [...parsed.warnings, "accepted bare JSON tool envelope without protocol tags"],
      };
    }
    if (parsed.kind === "none") {
      return parsed;
    }
    let bareJson: unknown;
    try {
      bareJson = parseJsonWithLikelyWindowsPathRepair(bare).value;
    } catch {
      bareJson = undefined;
    }
    if (isPlainObject(bareJson) && toolLikeEnvelopeKeys(bareJson)) {
      return parsed;
    }
  }

  const functionStyle = detectFunctionStyleToolCall(source);
  if (functionStyle) {
    return {
      kind: "error",
      code: "function_style_tool_call",
      message: `function-style tool calls like ${functionStyle.name}(...) are not valid Pi tool protocol`,
      raw: functionStyle.raw,
      text: source,
    };
  }

  const withoutHistory = stripPreviousToolCallHistoryBlocks(source);
  if (withoutHistory !== source.trim()) {
    if (!withoutHistory) {
      return {
        kind: "error",
        code: "raw_protocol_markup",
        message: "assistant final answer must not contain only raw or internal Pi tool protocol markup",
        raw: source,
        text: source,
      };
    }

    if (!containsRawProtocolMarkup(withoutHistory)) {
      return {
        kind: "none",
        text: withoutHistory,
      };
    }
  }

  if (containsRawProtocolMarkup(source)) {
    return {
      kind: "error",
      code: "raw_protocol_markup",
      message: "assistant final answer must not contain raw or internal Pi tool protocol markup",
      raw: source,
      text: source,
    };
  }

  return {
    kind: "none",
    text: source,
  };
}

export function hasToolCall(text: string): boolean {
  return parseToolCall(text).kind === "tool_call";
}

export function stripToolCall(text: string): string {
  const parsed = parseToolCall(text);
  if (parsed.kind !== "tool_call") return text;
  return [parsed.before, parsed.after].filter(Boolean).join("\n\n").trim();
}
