import { validateToolArguments } from "./argument-validator.ts";
import type { JsonObject } from "./protocol.ts";
import {
  buildInvalidToolArgumentsRepairPrompt,
  buildRepeatedToolRepairPrompt,
  buildUnknownToolRepairPrompt,
} from "./retry.ts";
import type { ToolLike } from "./serializer.ts";

type ToolCallRequest = {
  name: string;
  arguments: JsonObject;
};

export type ToolCallRecoveryEvent =
  | "recovery.unknown_tool"
  | "recovery.invalid_tool_arguments"
  | "recovery.repeated_tool";

export type ToolCallDecision =
  | {
      kind: "accept";
    }
  | {
      kind: "repair";
      event: ToolCallRecoveryEvent;
      prompt: string;
      toolName: string;
      errors?: string[];
    }
  | {
      kind: "final";
      text: string;
      toolName: string;
      errors?: string[];
    };

function sameToolCall(left: ToolCallRequest, right: ToolCallRequest): boolean {
  return left.name === right.name && JSON.stringify(left.arguments) === JSON.stringify(right.arguments);
}

export function decideToolCallRequest(input: {
  requestedCall: ToolCallRequest;
  selectedToolNames: ReadonlySet<string>;
  selectedToolNamesList: readonly string[];
  selectedToolByName: ReadonlyMap<string, ToolLike>;
  lastCompletedCall?: ToolCallRequest;
  canRepair: boolean;
}): ToolCallDecision {
  const { requestedCall, selectedToolNames, selectedToolNamesList, selectedToolByName, canRepair } = input;

  if (selectedToolNames.size === 0 || !selectedToolNames.has(requestedCall.name)) {
    if (canRepair) {
      return {
        kind: "repair",
        event: "recovery.unknown_tool",
        prompt: buildUnknownToolRepairPrompt(requestedCall.name, [...selectedToolNamesList]),
        toolName: requestedCall.name,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 请求了不可用工具：${requestedCall.name}。本轮可用工具：` +
        `${selectedToolNamesList.join(", ") || "(none)"}`,
      toolName: requestedCall.name,
    };
  }

  const argumentValidation = validateToolArguments(selectedToolByName.get(requestedCall.name), requestedCall.arguments);
  if (!argumentValidation.ok) {
    if (canRepair) {
      return {
        kind: "repair",
        event: "recovery.invalid_tool_arguments",
        prompt: buildInvalidToolArgumentsRepairPrompt(requestedCall.name, argumentValidation.errors),
        toolName: requestedCall.name,
        errors: argumentValidation.errors,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 请求了参数不符合 schema 的工具调用：${requestedCall.name}。\n\n` +
        `参数错误：${argumentValidation.errors.join("; ")}`,
      toolName: requestedCall.name,
      errors: argumentValidation.errors,
    };
  }

  if (input.lastCompletedCall && sameToolCall(input.lastCompletedCall, requestedCall)) {
    if (canRepair) {
      return {
        kind: "repair",
        event: "recovery.repeated_tool",
        prompt: buildRepeatedToolRepairPrompt(requestedCall.name),
        toolName: requestedCall.name,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 检测到模型在工具结果返回后仍重复请求同一个工具：${requestedCall.name}。\n\n` +
        "为避免重复执行工具或卡住，本轮已停止自动工具调用。请基于上方已有工具结果继续，或把任务拆小后重试。",
      toolName: requestedCall.name,
    };
  }

  return { kind: "accept" };
}
