import type { ToolCallParseResult } from "./parser-types.ts";
import {
  escapeLikelyWindowsPathStringContent,
  hasEvenBackslashPrefix,
  stripMarkdownFence,
} from "./windows-json-repair.ts";

function escapeLooseJsonStringContentForParse(value: string): string {
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && hasEvenBackslashPrefix(value, index)) {
      text += '\\"';
    } else if (char === "\n") {
      text += "\\n";
    } else if (char === "\r") {
      text += "\\r";
    } else if (char === "\t") {
      text += "\\t";
    } else {
      text += char;
    }
  }
  return text;
}

function decodeLooseJsonStringContent(value: string): string {
  const escapedQuotes = escapeLooseJsonStringContentForParse(value);
  const repaired = escapeLikelyWindowsPathStringContent(escapedQuotes);
  try {
    return JSON.parse(`"${repaired.text}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

export function parseLooseJsonActionFinal(raw: string): ToolCallParseResult | undefined {
  const cleaned = stripMarkdownFence(raw).trim();
  const prefix = cleaned.match(/^\{\s*"kind"\s*:\s*"final"\s*,\s*"text"\s*:\s*"/);
  if (!prefix) return undefined;

  const suffix = cleaned.match(/"\s*\}\s*$/);
  if (!suffix || suffix.index === undefined || suffix.index < prefix[0].length) return undefined;

  return {
    kind: "none",
    text: decodeLooseJsonStringContent(cleaned.slice(prefix[0].length, suffix.index)),
  };
}

export function detectFunctionStyleToolCall(value: string): { name: string; raw: string } | undefined {
  const trimmed = stripMarkdownFence(value).replace(/^`([\s\S]*)`$/, "$1").trim();
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/);
  if (!match) return undefined;

  const name = match[1];
  const rawArgs = match[2];
  if (!name || rawArgs === undefined) return undefined;
  const args = rawArgs.trim();
  if (!args.startsWith("{") || !args.endsWith("}")) return undefined;

  return { name, raw: `${name}(${args})` };
}

const RAW_PROTOCOL_MARKUP_PATTERN =
  /(?:<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|<\/?tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|<\/?previous_pi_tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[\/?previous_pi_tool_call\])/i;

export function containsRawProtocolMarkup(value: string): boolean {
  return RAW_PROTOCOL_MARKUP_PATTERN.test(value);
}

const PREVIOUS_TOOL_CALL_HISTORY_BLOCK_PATTERN =
  /(?:\[previous_pi_tool_call\]|<previous_pi_tool_call\b[^>]*>)[\s\S]*?(?:\[\/previous_pi_tool_call\]|<\/previous_pi_tool_call>)/gi;

export function stripPreviousToolCallHistoryBlocks(value: string): string {
  return value
    .replace(PREVIOUS_TOOL_CALL_HISTORY_BLOCK_PATTERN, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
