import type { Usage } from "@earendil-works/pi-ai";
import {
  EMPTY_USAGE,
  type UsageSummary,
} from "./protocol.ts";
import { safeBlockText } from "./text-safety.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    numeric = Number(value.trim());
  } else {
    return undefined;
  }
  if (!Number.isSafeInteger(numeric) || numeric < 0) return undefined;
  return numeric === 0 ? 0 : numeric;
}

function firstTokenCount(...values: unknown[]): number {
  for (const value of values) {
    const normalized = tokenCount(value);
    if (normalized !== undefined) return normalized;
  }
  return 0;
}

function addTokenCounts(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function normalizeUsageSummary(value: unknown): UsageSummary {
  const usage = isObject(value) ? value : {};
  const input = firstTokenCount(usage.input);
  const output = firstTokenCount(usage.output);
  const cacheRead = firstTokenCount(usage.cacheRead);
  const cacheWrite = firstTokenCount(usage.cacheWrite);
  const componentTotal = addTokenCounts(input, output, cacheRead, cacheWrite);
  const reportedTotal = firstTokenCount(usage.totalTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Math.max(componentTotal, reportedTotal),
  };
}

export function usageFromResponse(value: unknown): UsageSummary {
  if (!isObject(value)) return { ...EMPTY_USAGE };
  const input = firstTokenCount(value.prompt_tokens, value.input_tokens);
  const output = firstTokenCount(value.completion_tokens, value.output_tokens);
  const cacheRead = firstTokenCount(value.prompt_cache_hit_tokens, value.cache_read_tokens);
  const cacheWrite = firstTokenCount(value.prompt_cache_miss_tokens, value.cache_write_tokens);
  const componentTotal = addTokenCounts(input, output, cacheRead, cacheWrite);
  const reportedTotal = firstTokenCount(value.total_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Math.max(componentTotal, reportedTotal),
  };
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  const left = normalizeUsageSummary(a);
  const right = normalizeUsageSummary(b);
  const input = addTokenCounts(left.input, right.input);
  const output = addTokenCounts(left.output, right.output);
  const cacheRead = addTokenCounts(left.cacheRead, right.cacheRead);
  const cacheWrite = addTokenCounts(left.cacheWrite, right.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Math.max(
      addTokenCounts(input, output, cacheRead, cacheWrite),
      addTokenCounts(left.totalTokens, right.totalTokens),
    ),
  };
}

export function toPiUsage(usage: UsageSummary): Usage {
  const normalized = normalizeUsageSummary(usage);
  return {
    input: normalized.input,
    output: normalized.output,
    cacheRead: normalized.cacheRead,
    cacheWrite: normalized.cacheWrite,
    totalTokens: normalized.totalTokens,
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

function serializeNativeToolCall(toolCall: unknown): string | undefined {
  if (!isObject(toolCall)) return undefined;
  const fn = isObject(toolCall.function) ? toolCall.function : undefined;
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  const rawArgs = typeof fn?.arguments === "string" && fn.arguments.trim() ? fn.arguments.trim() : "{}";

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(rawArgs);
  } catch {
    return JSON.stringify({
      kind: "tool_call",
      name,
      arguments: {},
      _invalid_native_arguments: safeBlockText(rawArgs, 2000),
    });
  }

  return JSON.stringify({ kind: "tool_call", name, arguments: parsedArgs });
}

function nativeToolCallsText(message: Record<string, unknown>): string[] {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return toolCalls
    .map((toolCall) => serializeNativeToolCall(toolCall))
    .filter((item): item is string => Boolean(item));
}

export function extractTextFromMessage(message: unknown): string {
  if (!isObject(message)) return "";
  const contentText = contentTextFromMessageContent(message.content).trim();
  const toolCallTexts = nativeToolCallsText(message);
  if (toolCallTexts.length === 0) return contentText;
  return [contentText, ...toolCallTexts].filter(Boolean).join("\n\n");
}
