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
  /(?:<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[\/?previous_pi_tool_call\])/i;

function containsRawProtocolMarkup(value: string): boolean {
  return RAW_PROTOCOL_MARKUP_PATTERN.test(value);
}

function parseEnvelope(raw: string, originalText: string): ToolCallParseResult {
  const cleaned = stripMarkdownFence(raw);
  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
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
      code: "invalid_envelope",
      message: "tool envelope JSON must be an object",
      raw: cleaned,
      text: originalText,
    };
  }

  const keys = Object.keys(parsed).sort();
  const allowed = new Set(["arguments", "name"]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return {
      kind: "error",
      code: "unknown_top_level_field",
      message: `unknown top-level field(s): ${unknown.join(", ")}`,
      raw: cleaned,
      text: originalText,
    };
  }

  if (keys.length !== 2 || !keys.includes("name") || !keys.includes("arguments")) {
    return {
      kind: "error",
      code: "invalid_envelope",
      message: 'tool envelope must contain exactly "name" and "arguments"',
      raw: cleaned,
      text: originalText,
    };
  }

  if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
    return {
      kind: "error",
      code: "invalid_name",
      message: '"name" must be a non-empty string',
      raw: cleaned,
      text: originalText,
    };
  }

  if (!isPlainObject(parsed.arguments)) {
    return {
      kind: "error",
      code: "invalid_arguments",
      message: '"arguments" must be a JSON object',
      raw: cleaned,
      text: originalText,
    };
  }

  return {
    kind: "tool_call",
    call: {
      name: parsed.name.trim(),
      arguments: parsed.arguments,
    },
    before: "",
    after: "",
    rawJson: cleaned,
    warnings: [],
  };
}

function parseAttributedEnvelope(openTag: string, raw: string, originalText: string): ToolCallParseResult {
  const nameMatch = openTag.match(/\sname=(["'])([^"']+)\1/);
  if (!nameMatch) return parseEnvelope(raw, originalText);

  const cleaned = stripMarkdownFence(raw);
  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
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

  const name = nameMatch[2].trim();
  if (!name) {
    return {
      kind: "error",
      code: "invalid_name",
      message: 'tool-call tag attribute "name" must be a non-empty string',
      raw: cleaned,
      text: originalText,
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
    warnings: ["accepted attributed pi_tool_call tag"],
  };
}

function findTaggedToolCalls(text: string): Array<{ start: number; end: number; body: string; openTag: string }> {
  const results: Array<{ start: number; end: number; body: string; openTag: string }> = [];
  const openTagPattern = /<pi_tool_call(?:\s+[^>]*)?>/g;

  for (let match = openTagPattern.exec(text); match; match = openTagPattern.exec(text)) {
    const start = match.index;
    const openTag = match[0];
    const bodyStart = start + openTag.length;
    const close = text.indexOf(TOOL_CALL_CLOSE, bodyStart);
    if (close === -1) {
      results.push({ start, end: text.length, body: text.slice(bodyStart), openTag });
      break;
    }
    const end = close + TOOL_CALL_CLOSE.length;
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

    const before = source.slice(0, tagged.start).trim();
    const after = source.slice(tagged.end).trim();
    const warnings = [...parsed.warnings];
    if (before || after) {
      warnings.push("tool envelope had surrounding text");
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
