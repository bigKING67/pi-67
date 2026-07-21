import type { ToolCallParseResult } from "./parser.ts";
import {
  buildFunctionStyleToolRepairPrompt,
  buildInvalidToolJsonRepairPrompt,
  buildMalformedWindowsBashJsonRepairPrompt,
  buildRawProtocolMarkupRepairPrompt,
  buildSelectedToolDirectKindRepairPrompt,
} from "./turn/recovery-prompts.ts";

export type ParseErrorResult = Extract<ToolCallParseResult, { kind: "error" }>;

export type ParseErrorRecoveryEvent =
  | "recovery.function_style_tool_call"
  | "recovery.selected_tool_direct_kind"
  | "recovery.malformed_windows_bash_json"
  | "recovery.raw_protocol_markup"
  | "recovery.invalid_tool_json";

export type ParseErrorRepairPlan = {
  prompt: string;
  event: ParseErrorRecoveryEvent;
};

export function parseErrorRecoveryBudget(parsed: ParseErrorResult): "repair" | "format" {
  return parsed.code === "selected_tool_direct_kind" ||
    parsed.code === "malformed_windows_bash_json"
    ? "repair"
    : "format";
}

export function canRecoverEmptyResponse(
  counters: { emptyRetries: number; totalRecoveries: number },
  budget: { maxEmptyRetries: number; maxTotalRecoveries: number },
): boolean {
  return counters.emptyRetries < budget.maxEmptyRetries &&
    counters.totalRecoveries < budget.maxTotalRecoveries;
}

export function canRecoverRepair(
  counters: { repairRetries: number; totalRecoveries: number },
  budget: { maxRepairRetries: number; maxTotalRecoveries: number },
): boolean {
  return counters.repairRetries < budget.maxRepairRetries &&
    counters.totalRecoveries < budget.maxTotalRecoveries;
}

export function buildParseErrorRepairPlan(
  parsed: ParseErrorResult,
  selectedToolNames: readonly string[],
): ParseErrorRepairPlan {
  const names = [...selectedToolNames];
  if (parsed.code === "function_style_tool_call") {
    return {
      event: "recovery.function_style_tool_call",
      prompt: buildFunctionStyleToolRepairPrompt(parsed.raw, names),
    };
  }

  if (parsed.code === "selected_tool_direct_kind") {
    return {
      event: "recovery.selected_tool_direct_kind",
      prompt: buildSelectedToolDirectKindRepairPrompt(parsed.raw, names),
    };
  }

  if (parsed.code === "malformed_windows_bash_json") {
    return {
      event: "recovery.malformed_windows_bash_json",
      prompt: buildMalformedWindowsBashJsonRepairPrompt(parsed.raw, names),
    };
  }

  if (parsed.code === "raw_protocol_markup") {
    return {
      event: "recovery.raw_protocol_markup",
      prompt: buildRawProtocolMarkupRepairPrompt(parsed.raw, names),
    };
  }

  return {
    event: "recovery.invalid_tool_json",
    prompt: buildInvalidToolJsonRepairPrompt(parsed.message, parsed.raw, names),
  };
}
