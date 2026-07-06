import type { ToolCallParseResult } from "./parser.ts";
import type { XtalpiActionProtocol } from "./local-action-adapter.ts";
import {
  buildFunctionStyleToolRepairPrompt,
  buildInvalidToolJsonRepairPrompt,
  buildRawProtocolMarkupRepairPrompt,
} from "./retry.ts";

export type ParseErrorResult = Extract<ToolCallParseResult, { kind: "error" }>;

export type ParseErrorRecoveryEvent =
  | "recovery.function_style_tool_call"
  | "recovery.raw_protocol_markup"
  | "recovery.invalid_tool_json";

export type ParseErrorRepairPlan = {
  prompt: string;
  event: ParseErrorRecoveryEvent;
};

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
  actionProtocol: XtalpiActionProtocol = "text",
): ParseErrorRepairPlan {
  const names = [...selectedToolNames];
  if (parsed.code === "function_style_tool_call") {
    return {
      event: "recovery.function_style_tool_call",
      prompt: buildFunctionStyleToolRepairPrompt(parsed.raw, names, actionProtocol),
    };
  }

  if (parsed.code === "raw_protocol_markup") {
    return {
      event: "recovery.raw_protocol_markup",
      prompt: buildRawProtocolMarkupRepairPrompt(parsed.raw, names, actionProtocol),
    };
  }

  return {
    event: "recovery.invalid_tool_json",
    prompt: buildInvalidToolJsonRepairPrompt(parsed.message, parsed.raw, names, actionProtocol),
  };
}
