import {
  TOOL_RESULT_CLOSE,
  TOOL_RESULT_OPEN,
} from "../protocol.ts";
import { redactSensitiveString } from "../diagnostics.ts";
import {
  contentToText,
  type MessageLike,
} from "./message-content.ts";
import {
  repeatPolicyForObservation,
  type RepeatPolicyName,
} from "../tools/repeat-policy.ts";
import type {
  ToolExecutionObservation,
  ToolExecutionStatus,
} from "../turn/tool-execution-ledger.ts";
import {
  safeBlockText,
  safeInlineText,
} from "../text-safety.ts";

export type ToolResultReceipt = {
  schema: "xtalpi-pi-tools.tool-result.v2";
  tool_call_id: string;
  tool_name: string;
  fingerprint?: string;
  arguments_summary?: Record<string, unknown>;
  status: ToolExecutionStatus;
  error_code?: string;
  repeat_policy: RepeatPolicyName;
  suggested_next:
    | "use_existing_result_or_final"
    | "use_different_discovery_tool_or_final"
    | "retry_same_call_once"
    | "use_different_approach_or_final";
  content_is_untrusted: true;
  tool_name_mismatch?: true;
  content: string;
};

const SENSITIVE_ARGUMENT_KEY = /(?:api[_-]?key|authorization|cookie|password|passwd|secret|session|token|private[_-]?key)/i;

function summarizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?[query omitted]" : ""}`;
  } catch {
    return value;
  }
}

function summarizeArgumentValue(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_ARGUMENT_KEY.test(key)) return "[REDACTED]";
  if (key === "command") return "[OMITTED_SIDE_EFFECTING_COMMAND]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const normalized = /(?:url|uri)$/i.test(key) ? summarizeUrl(value) : value;
    return safeInlineText(redactSensitiveString(normalized), 240);
  }
  if (depth >= 2) return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  if (Array.isArray(value)) {
    return value.slice(0, 4).map((item) => summarizeArgumentValue(key, item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 8)) {
      output[safeInlineText(childKey, 80)] = summarizeArgumentValue(childKey, childValue, depth + 1);
    }
    return output;
  }
  return safeInlineText(String(value), 120);
}

export function summarizeToolArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(argumentsValue).slice(0, 12)) {
    output[safeInlineText(key, 80)] = summarizeArgumentValue(key, value, 0);
  }
  return output;
}

export function buildToolResultReceipt(input: {
  message: MessageLike;
  observation?: ToolExecutionObservation;
  maxToolResultChars: number;
}): ToolResultReceipt {
  const { message, observation } = input;
  const repeatPolicy = observation
    ? repeatPolicyForObservation(observation)
    : {
        policy: "same_call_forbidden" as const,
        suggestedNext: "use_different_approach_or_final" as const,
      };
  const content = safeBlockText(contentToText(message.content), input.maxToolResultChars);
  const toolName = observation?.toolCall.name ||
    (typeof message.toolName === "string" ? message.toolName : "unknown");
  const toolCallId = observation?.toolCall.id ||
    (typeof message.toolCallId === "string" ? message.toolCallId : "unknown");
  const argumentsSummary = observation
    ? summarizeToolArguments(observation.toolCall.arguments)
    : undefined;

  return {
    schema: "xtalpi-pi-tools.tool-result.v2",
    tool_call_id: safeInlineText(toolCallId, 160) || "unknown",
    tool_name: safeInlineText(toolName, 160) || "unknown",
    ...(observation ? { fingerprint: observation.fingerprint } : {}),
    ...(argumentsSummary && Object.keys(argumentsSummary).length > 0
      ? { arguments_summary: argumentsSummary }
      : {}),
    status: observation?.status ?? (message.isError === true ? "unknown_error" : "success"),
    ...(observation?.errorCode ? { error_code: observation.errorCode } : {}),
    repeat_policy: repeatPolicy.policy,
    suggested_next: repeatPolicy.suggestedNext,
    content_is_untrusted: true,
    ...(observation?.toolNameMismatch ? { tool_name_mismatch: true as const } : {}),
    content,
  };
}

export function serializeToolResultReceipt(input: {
  message: MessageLike;
  observation?: ToolExecutionObservation;
  maxToolResultChars: number;
}): string {
  const receipt = buildToolResultReceipt(input);
  return `${TOOL_RESULT_OPEN}\ncontent_is_untrusted: true\nreceipt_json: ${JSON.stringify(receipt)}\n${TOOL_RESULT_CLOSE}`;
}
