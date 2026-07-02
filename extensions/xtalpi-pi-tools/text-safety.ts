const CONTROL_CHARS_EXCEPT_COMMON_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PROTOCOL_MARKUP_TAG = /<\/?pi_tool_(?:call_history|call|result)\b[^>]*>/gi;

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars by xtalpi-pi-tools]`;
}

function protocolMarkerLabel(tag: string): string {
  const match = tag.match(/<\/?(pi_tool_(?:call_history|call|result))\b/i);
  const name = (match?.[1] || "pi_tool_protocol").toLowerCase();
  const direction = tag.startsWith("</") ? "close" : "open";
  return `[literal ${name} ${direction} tag]`;
}

export function neutralizeProtocolMarkers(value: string): string {
  return value.replace(PROTOCOL_MARKUP_TAG, protocolMarkerLabel);
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
