import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_HISTORY_CLOSE,
  TOOL_CALL_HISTORY_OPEN,
  TOOL_CALL_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_RESULT_OPEN,
} from "./protocol.ts";

const CONTROL_CHARS_EXCEPT_COMMON_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars by xtalpi-pi-tools]`;
}

export function neutralizeProtocolMarkers(value: string): string {
  return value
    .replaceAll(TOOL_CALL_OPEN, "[literal pi_tool_call open tag]")
    .replaceAll(TOOL_CALL_CLOSE, "[literal pi_tool_call close tag]")
    .replaceAll(TOOL_RESULT_OPEN, "[literal pi_tool_result open tag]")
    .replaceAll(TOOL_RESULT_CLOSE, "[literal pi_tool_result close tag]")
    .replaceAll(TOOL_CALL_HISTORY_OPEN, "[literal pi_tool_call_history open tag]")
    .replaceAll(TOOL_CALL_HISTORY_CLOSE, "[literal pi_tool_call_history close tag]");
}

export function safeBlockText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(CONTROL_CHARS_EXCEPT_COMMON_WHITESPACE, " ");
  return neutralizeProtocolMarkers(truncateText(text, maxChars));
}

export function safeInlineText(value: unknown, maxChars: number): string {
  return safeBlockText(value, maxChars)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify("[unserializable JSON value]");
  }
}

export function formatToolNameForPrompt(name: string): string {
  return JSON.stringify(safeInlineText(name, 160));
}

export function formatToolNamesForPrompt(names: string[], maxItems = 80): string {
  const items = names.slice(0, maxItems).map(formatToolNameForPrompt);
  return items.join(", ") || "(none)";
}
