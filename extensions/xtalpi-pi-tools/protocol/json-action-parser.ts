import {
  TOOL_CALL_OPEN,
  type JsonObject,
} from "../protocol.ts";
import {
  containsRawProtocolMarkup,
  detectFunctionStyleToolCall,
  parseLooseJsonActionFinal,
  stripPreviousToolCallHistoryBlocks,
} from "./final-boundary.ts";
import {
  isPlainObject,
  normalizeParsedEnvelope,
  parseLooseNameArgumentsEnvelope,
  strictJsonActionFieldsError,
  toolLikeEnvelopeKeys,
} from "./legacy-normalizer.ts";
import {
  parseJsonWithLikelyWindowsPathRepair,
  stripMarkdownFence,
} from "./windows-json-repair.ts";
import type { ToolCallParseResult } from "./parser-types.ts";

export type { ToolCallParseResult } from "./parser-types.ts";

function exactKeySet(object: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  const warnings: string[] = ["accepted attributed pi_tool_call tag"];

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

  const tagged = taggedCalls.at(0);
  if (tagged) {
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

export function parseJsonAction(text: string): ToolCallParseResult {
  const source = String(text ?? "");
  const trimmed = stripMarkdownFence(source).trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    const functionStyle = detectFunctionStyleToolCall(source);
    if (functionStyle) {
      return {
        kind: "error",
        code: "function_style_tool_call",
        message: `function-style tool calls like ${functionStyle.name}(...) are not valid JSON action protocol`,
        raw: functionStyle.raw,
        text: source,
      };
    }

    if (containsRawProtocolMarkup(source)) {
      return {
        kind: "error",
        code: "raw_protocol_markup",
        message: "JSON action mode requires a single JSON object, not legacy Pi tool markup",
        raw: source,
        text: source,
      };
    }

    return {
      kind: "error",
      code: "invalid_json",
      message: "JSON action mode requires exactly one compact JSON object",
      raw: source,
      text: source,
    };
  }

  let parsed: unknown;
  let cleaned = trimmed;
  let warnings: string[] = [];
  try {
    const parsedJson = parseJsonWithLikelyWindowsPathRepair(trimmed);
    parsed = parsedJson.value;
    cleaned = parsedJson.jsonText;
    warnings = parsedJson.warnings;
  } catch (error) {
    const looseFinal = parseLooseJsonActionFinal(trimmed);
    if (looseFinal) return looseFinal;

    return {
      kind: "error",
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
      raw: trimmed,
      text: source,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: "JSON action envelope must be an object",
      raw: cleaned,
      text: source,
    };
  }

  if (parsed.kind === "final") {
    if (!exactKeySet(parsed, ["kind", "text"])) {
      return strictJsonActionFieldsError(parsed, ["kind", "text"], cleaned, source);
    }
    if (typeof parsed.text !== "string") {
      return {
        kind: "error",
        code: "invalid_envelope",
        message: 'JSON action envelope with kind "final" must contain string field "text"',
        raw: cleaned,
        text: source,
      };
    }
    return {
      kind: "none",
      text: parsed.text,
    };
  }

  if (parsed.kind !== "tool_call") {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: 'JSON action envelope must contain kind "tool_call" or "final"',
      raw: cleaned,
      text: source,
    };
  }

  if (!exactKeySet(parsed, ["arguments", "kind", "name"])) {
    return strictJsonActionFieldsError(parsed, ["arguments", "kind", "name"], cleaned, source);
  }

  if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
    return {
      kind: "error",
      code: "invalid_name",
      message: 'JSON action "name" must be a non-empty string',
      raw: cleaned,
      text: source,
    };
  }

  if (!isPlainObject(parsed.arguments)) {
    return {
      kind: "error",
      code: "invalid_arguments",
      message: 'JSON action "arguments" must be an object',
      raw: cleaned,
      text: source,
    };
  }

  return {
    kind: "tool_call",
    call: { name: parsed.name.trim(), arguments: parsed.arguments },
    before: "",
    after: "",
    rawJson: JSON.stringify({ kind: "tool_call", name: parsed.name.trim(), arguments: parsed.arguments }),
    warnings: [...warnings, "accepted strict JSON action tool_call envelope"],
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
