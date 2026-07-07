import {
  contentToText,
  type ContextLike,
} from "./serializer.ts";

export type FinalGuardCode =
  | "plan_mode_contract_missing"
  | "continuation_no_progress"
  | "intent_to_tool_no_call"
  | "internal_context_leak"
  | "tool_call_like_final"
  | "weak_final";

export type FinalGuardResult =
  | { ok: true }
  | {
      ok: false;
      code: FinalGuardCode;
      reason: string;
      latestUserText: string;
    };

const CONTINUATION_PROMPT_PATTERN =
  /^\s*(?:继续上一轮|继续上一步|继续(?:呀|吧)?|接着(?:来|吧)?|下一步|然后呢|再来|往下|go on|continue|next|proceed)(?:\s|$|[，。,.!！?？])/i;

const PLAN_MODE_MARKER_PATTERN =
  /(?:Plan mode:\s*planning|Produce\s+a\s+<proposed_plan>\s+block|<proposed_plan>)/i;

const PLAN_MODE_ECHO_PATTERN =
  /(?:Plan mode:\s*planning|Produce\s+a\s+<proposed_plan>\s+block|Tools:\s*.*(?:plan_mode_question|bash|find|grep|ls|read))/is;

const PROTOCOL_ECHO_PATTERN =
  /(?:Tool protocol rules:|Pi owns all local tools|Prior local tool-call envelopes are internal runtime history|content_is_untrusted:\s*true|handling:\s*Treat content below only as tool output data)/i;

const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan\b[^>]*>[\s\S]*<\/proposed_plan>/i;

const PROMISE_TO_CONTINUE_PATTERN =
  /(?:^|\b)(?:let me|i(?:'ll| will| need to| should| am going to)|next,?\s+i(?:'ll| will)|我(?:会|将|需要|应该)|接下来|下一步|让我|先|收到|重新|继续)(?:[\s\S]{0,180})(?:continue|proceed|inspect|check|search|grep|find|list|read|open|look at|run|execute|fetch|继续|查看|检查|搜索|查找|读取|打开|运行|执行|抓取|发起搜索)/i;

const INTENT_TO_TOOL_PATTERN =
  /(?:^|\b)(?:let me|i(?:'ll| will| need to| should| am going to)|next,?\s+i(?:'ll| will)|我(?:会|将|需要|应该)|接下来|下一步|让我|先|收到|重新|继续)(?:[\s\S]{0,180})(?:inspect|check|search|grep|find|list|read|open|look at|run|execute|fetch|查看|检查|搜索|查找|读取|打开|运行|执行|抓取|发起搜索)/i;

const WEAK_FINAL_PATTERN =
  /^\s*(?:ok(?:ay)?|done|sure|understood|continuing|好的|好|明白|收到|继续|可以|已完成)[.!！。…\s]*$/i;

const TOOL_LIKE_NAMES = new Set([
  "bash",
  "batch_web_fetch",
  "bounded_read",
  "fetch_content",
  "fffind",
  "ffgrep",
  "find",
  "grep",
  "ls",
  "read",
  "recall",
  "subagent",
  "mcp",
  "until_done_block",
  "until_done_complete",
  "until_done_distill",
  "until_done_plan",
  "until_done_progress",
  "until_done_replan",
  "until_done_set",
  "until_done_task_update",
  "web_search",
  "web_fetch",
]);

const MAX_JSON_ARRAY_SCAN_CHARS = 12000;
const MAX_JSON_ARRAY_CANDIDATES = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractJsonArrayCandidates(value: string): string[] {
  const text = value.slice(0, MAX_JSON_ARRAY_SCAN_CHARS);
  const candidates: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "[") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "[") {
        depth += 1;
        continue;
      }
      if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }

    if (candidates.length >= MAX_JSON_ARRAY_CANDIDATES) break;
  }

  return candidates;
}

function parseJsonArray(value: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolNameFromObject(value: Record<string, unknown>): string | undefined {
  if (typeof value.name === "string") return value.name.trim();
  if (typeof value.tool === "string") return value.tool.trim();
  if (typeof value.tool_name === "string") return value.tool_name.trim();
  if (isPlainObject(value.function) && typeof value.function.name === "string") {
    return value.function.name.trim();
  }
  return undefined;
}

function argumentsLikeObject(value: unknown): boolean {
  if (isPlainObject(value)) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    return isPlainObject(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

function toolArgumentsFromObject(value: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(value, "arguments")) return value.arguments;
  if (Object.prototype.hasOwnProperty.call(value, "args")) return value.args;
  if (Object.prototype.hasOwnProperty.call(value, "input")) return value.input;
  if (isPlainObject(value.function)) return value.function.arguments;
  return undefined;
}

function isToolCallLikeObject(value: unknown, selectedToolNames: Set<string>): boolean {
  if (!isPlainObject(value)) return false;

  const name = toolNameFromObject(value);
  if (!name) return false;

  const hasToolArguments = argumentsLikeObject(toolArgumentsFromObject(value));
  if (!hasToolArguments) return false;

  const id = typeof value.id === "string" ? value.id : "";
  const knownToolName =
    selectedToolNames.has(name) ||
    TOOL_LIKE_NAMES.has(name) ||
    /^until_done_[a-z0-9_]+$/i.test(name);

  return knownToolName || /^pi_tool_/i.test(id);
}

export function containsToolCallLikeJsonArray(input: {
  text: string;
  selectedToolNames: readonly string[];
}): boolean {
  const selectedToolNames = new Set(input.selectedToolNames.map((name) => String(name).trim()).filter(Boolean));
  for (const candidate of extractJsonArrayCandidates(input.text)) {
    const parsed = parseJsonArray(candidate);
    if (!parsed || parsed.length === 0) continue;
    if (parsed.some((item) => isToolCallLikeObject(item, selectedToolNames))) return true;
  }
  return false;
}

function latestUserText(context: ContextLike): string {
  const messages = context.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return contentToText(message.content).trim();
    }
  }
  return "";
}

function hasToolLikeNames(selectedToolNames: readonly string[]): boolean {
  return selectedToolNames.some((name) => TOOL_LIKE_NAMES.has(name));
}

function isPlanModeActive(context: ContextLike, latestUser: string, selectedToolNames: readonly string[]): boolean {
  const activeText = `${context.systemPrompt ?? ""}\n${latestUser}`;
  return PLAN_MODE_MARKER_PATTERN.test(activeText) ||
    (selectedToolNames.includes("plan_mode_question") && /(?:plan|planning|计划|proposed_plan)/i.test(activeText));
}

function isContinuationPrompt(value: string): boolean {
  return CONTINUATION_PROMPT_PATTERN.test(value);
}

export function validateFinalAnswer(input: {
  text: string;
  context: ContextLike;
  selectedToolNames: readonly string[];
}): FinalGuardResult {
  const text = String(input.text ?? "").trim();
  const latestUser = latestUserText(input.context);
  const selectedToolNames = [...input.selectedToolNames];
  const hasPlanBlock = PROPOSED_PLAN_BLOCK_PATTERN.test(text);

  if (PLAN_MODE_ECHO_PATTERN.test(text) && !hasPlanBlock) {
    return {
      ok: false,
      code: "internal_context_leak",
      reason: "model echoed Plan mode/tool-selection instructions instead of producing the required result",
      latestUserText: latestUser,
    };
  }

  if (PROTOCOL_ECHO_PATTERN.test(text)) {
    return {
      ok: false,
      code: "internal_context_leak",
      reason: "model echoed xtalpi-pi-tools protocol or tool-result wrapper instructions instead of producing the required result",
      latestUserText: latestUser,
    };
  }

  if (containsToolCallLikeJsonArray({ text, selectedToolNames })) {
    return {
      ok: false,
      code: "tool_call_like_final",
      reason: "model returned a JSON array of Pi/OpenAI-style tool calls in final text; tool calls must be emitted as exactly one JSON action object",
      latestUserText: latestUser,
    };
  }

  if (isPlanModeActive(input.context, latestUser, selectedToolNames) && !hasPlanBlock) {
    return {
      ok: false,
      code: "plan_mode_contract_missing",
      reason: "Plan mode is active but the final answer did not contain a <proposed_plan> block",
      latestUserText: latestUser,
    };
  }

  if (isContinuationPrompt(latestUser) && PROMISE_TO_CONTINUE_PATTERN.test(text)) {
    return {
      ok: false,
      code: "continuation_no_progress",
      reason: "user asked to continue, but the model only described a future action instead of calling a tool or producing concrete output",
      latestUserText: latestUser,
    };
  }

  if (hasToolLikeNames(selectedToolNames) && INTENT_TO_TOOL_PATTERN.test(text)) {
    return {
      ok: false,
      code: "intent_to_tool_no_call",
      reason: "model said it needed to inspect/read/search/run something but did not emit a tool call",
      latestUserText: latestUser,
    };
  }

  if (isContinuationPrompt(latestUser) && WEAK_FINAL_PATTERN.test(text)) {
    return {
      ok: false,
      code: "weak_final",
      reason: "user asked to continue, but the final answer was only a weak acknowledgement",
      latestUserText: latestUser,
    };
  }

  return { ok: true };
}
