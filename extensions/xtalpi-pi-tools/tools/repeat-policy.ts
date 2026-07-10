import type { ToolExecutionObservation } from "../turn/tool-execution-ledger.ts";

export type RepeatPolicyName =
  | "same_call_forbidden"
  | "same_call_allowed_once_after_transient_error";

export type RepeatPolicyDecision = {
  allow: boolean;
  policy: RepeatPolicyName;
  reason:
    | "previous_success"
    | "deterministic_error"
    | "transient_read_only_retry_available"
    | "transient_retry_already_used"
    | "side_effecting_or_unknown_tool"
    | "unknown_error"
    | "cancelled";
  suggestedNext:
    | "use_existing_result_or_final"
    | "use_different_discovery_tool_or_final"
    | "retry_same_call_once"
    | "use_different_approach_or_final";
};

const READ_ONLY_IDEMPOTENT_TOOLS = new Set([
  "batch_web_fetch",
  "fetch_content",
  "fffind",
  "ffgrep",
  "find",
  "grep",
  "ls",
  "read",
  "web_fetch",
  "web_search",
]);

const PATH_DISCOVERY_TOOL_PRIORITY = ["fffind", "find", "ls", "ffgrep", "grep"] as const;

export function isReadOnlyIdempotentTool(toolName: string): boolean {
  return READ_ONLY_IDEMPOTENT_TOOLS.has(toolName);
}

export function pathDiscoveryToolNames(
  availableToolNames: Iterable<string>,
  limit = 2,
): string[] {
  const available = new Set(availableToolNames);
  return PATH_DISCOVERY_TOOL_PRIORITY
    .filter((name) => available.has(name))
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function repeatPolicyForObservation(
  observation: ToolExecutionObservation,
): RepeatPolicyDecision {
  if (observation.status === "success") {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "previous_success",
      suggestedNext: "use_existing_result_or_final",
    };
  }
  if (observation.status === "deterministic_error") {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "deterministic_error",
      suggestedNext: observation.errorCode === "ENOENT"
        ? "use_different_discovery_tool_or_final"
        : "use_different_approach_or_final",
    };
  }
  if (observation.status === "cancelled") {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "cancelled",
      suggestedNext: "use_different_approach_or_final",
    };
  }
  if (observation.status === "unknown_error") {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "unknown_error",
      suggestedNext: "use_different_approach_or_final",
    };
  }
  if (!isReadOnlyIdempotentTool(observation.toolCall.name)) {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "side_effecting_or_unknown_tool",
      suggestedNext: "use_different_approach_or_final",
    };
  }
  if (observation.sameFingerprintExecutionCount >= 2) {
    return {
      allow: false,
      policy: "same_call_forbidden",
      reason: "transient_retry_already_used",
      suggestedNext: "use_different_approach_or_final",
    };
  }
  return {
    allow: true,
    policy: "same_call_allowed_once_after_transient_error",
    reason: "transient_read_only_retry_available",
    suggestedNext: "retry_same_call_once",
  };
}
