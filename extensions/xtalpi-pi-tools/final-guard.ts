import {
  contentToText,
  type ContextLike,
} from "./serializer.ts";
import {
  detectToolCallLikeFinal,
} from "./protocol-boundary.ts";

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

const PLAN_MODE_ACTIVE_MARKER_PATTERN =
  /(?:Plan mode:\s*planning|Produce\s+a\s+<proposed_plan>\s+block)/i;

const PLAN_MODE_DISABLED_IMPLEMENT_PATTERN =
  /^\s*Plan mode is now disabled\.\s*Full tool access is restored\.\s*Implement this proposed plan now:/i;

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

export function containsToolCallLikeJsonArray(input: {
  text: string;
  selectedToolNames: readonly string[];
}): boolean {
  return !detectToolCallLikeFinal(input).ok;
}

function latestUserText(context: ContextLike): string {
  const messages = context.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      return contentToText(message.content).trim();
    }
  }
  return "";
}

function hasToolLikeNames(selectedToolNames: readonly string[]): boolean {
  return selectedToolNames.some((name) => String(name || "").trim() && name !== "plan_mode_question");
}

function isPlanModeActive(context: ContextLike, latestUser: string): boolean {
  if (PLAN_MODE_DISABLED_IMPLEMENT_PATTERN.test(latestUser)) return false;
  const activeText = `${context.systemPrompt ?? ""}\n${latestUser}`;
  return PLAN_MODE_ACTIVE_MARKER_PATTERN.test(activeText);
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

  const toolLikeFinal = detectToolCallLikeFinal({ text, selectedToolNames });
  if (!toolLikeFinal.ok) {
    return {
      ok: false,
      code: "tool_call_like_final",
      reason: `${toolLikeFinal.reason}; shape=${toolLikeFinal.matchedShape}; code=${toolLikeFinal.code}`,
      latestUserText: latestUser,
    };
  }

  if (isPlanModeActive(input.context, latestUser) && !hasPlanBlock) {
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
