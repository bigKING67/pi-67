import type { Usage } from "@earendil-works/pi-ai";
import {
  EMPTY_USAGE,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  type UsageSummary,
} from "./protocol.ts";
import {
  DEFAULT_ACTION_PROTOCOL,
  type XtalpiActionProtocol,
} from "./local-action-adapter.ts";
import { safeBlockText } from "./text-safety.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function usageFromResponse(value: unknown): UsageSummary {
  if (!isObject(value)) return { ...EMPTY_USAGE };
  const input = Number(value.prompt_tokens ?? value.input_tokens ?? 0);
  const output = Number(value.completion_tokens ?? value.output_tokens ?? 0);
  const cacheRead = Number(value.prompt_cache_hit_tokens ?? value.cache_read_tokens ?? 0);
  const cacheWrite = Number(value.prompt_cache_miss_tokens ?? value.cache_write_tokens ?? 0);
  const totalTokens = Number(value.total_tokens ?? input + output + cacheRead + cacheWrite);
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function toPiUsage(usage: UsageSummary): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function contentTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isObject(block) && typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

function serializeNativeToolCall(toolCall: unknown, actionProtocol: XtalpiActionProtocol): string | undefined {
  if (!isObject(toolCall)) return undefined;
  const fn = isObject(toolCall.function) ? toolCall.function : undefined;
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  const rawArgs = typeof fn?.arguments === "string" && fn.arguments.trim() ? fn.arguments.trim() : "{}";

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(rawArgs);
  } catch {
    if (actionProtocol === "json_action") {
      return JSON.stringify({
        kind: "tool_call",
        name,
        arguments: {},
        _invalid_native_arguments: safeBlockText(rawArgs, 2000),
      });
    }
    return `${TOOL_CALL_OPEN}
${JSON.stringify({
  name,
  arguments: {},
  _invalid_native_arguments: safeBlockText(rawArgs, 2000),
})}
${TOOL_CALL_CLOSE}`;
  }

  if (actionProtocol === "json_action") {
    return JSON.stringify({ kind: "tool_call", name, arguments: parsedArgs });
  }

  return `${TOOL_CALL_OPEN}
${JSON.stringify({ name, arguments: parsedArgs })}
${TOOL_CALL_CLOSE}`;
}

function nativeToolCallsText(message: Record<string, unknown>, actionProtocol: XtalpiActionProtocol): string[] {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return toolCalls
    .map((toolCall) => serializeNativeToolCall(toolCall, actionProtocol))
    .filter((item): item is string => Boolean(item));
}

export function extractTextFromMessage(message: unknown, actionProtocol: XtalpiActionProtocol = DEFAULT_ACTION_PROTOCOL): string {
  if (!isObject(message)) return "";
  const contentText = contentTextFromMessageContent(message.content).trim();
  const toolCallTexts = nativeToolCallsText(message, actionProtocol);
  if (toolCallTexts.length === 0) return contentText;
  return [contentText, ...toolCallTexts].filter(Boolean).join("\n\n");
}
