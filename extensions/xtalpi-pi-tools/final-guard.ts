import {
  contentToText,
  type ContextLike,
} from "./serializer.ts";

export type FinalGuardCode =
  | "plan_mode_contract_missing"
  | "continuation_no_progress"
  | "intent_to_tool_no_call"
  | "internal_context_leak"
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

const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan\b[^>]*>[\s\S]*<\/proposed_plan>/i;

const PROMISE_TO_CONTINUE_PATTERN =
  /(?:^|\b)(?:let me|i(?:'ll| will| need to| should| am going to)|next,?\s+i(?:'ll| will)|我(?:会|将|需要|应该)|接下来|下一步|让我|先)(?:[\s\S]{0,180})(?:continue|proceed|inspect|check|search|grep|find|list|read|open|look at|run|execute|fetch|继续|查看|检查|搜索|查找|读取|打开|运行|执行|抓取)/i;

const INTENT_TO_TOOL_PATTERN =
  /(?:^|\b)(?:let me|i(?:'ll| will| need to| should| am going to)|next,?\s+i(?:'ll| will)|我(?:会|将|需要|应该)|接下来|下一步|让我|先)(?:[\s\S]{0,180})(?:inspect|check|search|grep|find|list|read|open|look at|run|execute|fetch|查看|检查|搜索|查找|读取|打开|运行|执行|抓取)/i;

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
  "web_fetch",
]);

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
