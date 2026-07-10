import {
  validateToolArguments,
  type ArgumentValidationWarning,
} from "./argument-validator.ts";
import { jsonDeepEqual } from "./json-utils.ts";
import type { JsonObject } from "./protocol.ts";
import {
  buildInvalidToolArgumentsRepairPrompt,
  buildRepeatedToolRepairPrompt,
  buildShellCommandMismatchRepairPrompt,
  buildUnknownToolRepairPrompt,
} from "./retry.ts";
import { validateShellCommandRequest } from "./shell-command-guard.ts";
import type { ToolLike } from "./serializer.ts";
import {
  repeatPolicyForObservation,
  type RepeatPolicyDecision,
} from "./tools/repeat-policy.ts";
import type { ToolExecutionObservation } from "./turn/tool-execution-ledger.ts";

type ToolCallRequest = {
  name: string;
  arguments: JsonObject;
};

export type ToolCallRecoveryEvent =
  | "recovery.unknown_tool"
  | "recovery.invalid_tool_arguments"
  | "recovery.repeated_tool"
  | "recovery.shell_command_mismatch";

export type ToolCallDecision =
  | {
      kind: "accept";
      argumentValidationWarnings: ArgumentValidationWarning[];
      repeatPolicyDecision?: RepeatPolicyDecision;
    }
  | {
      kind: "repair";
      event: ToolCallRecoveryEvent;
      prompt: string;
      toolName: string;
      errors?: string[];
      argumentValidationWarnings?: ArgumentValidationWarning[];
    }
  | {
      kind: "final";
      text: string;
      toolName: string;
      errors?: string[];
      argumentValidationWarnings?: ArgumentValidationWarning[];
    };

function sameToolCall(left: ToolCallRequest, right: ToolCallRequest): boolean {
  return left.name === right.name && jsonDeepEqual(left.arguments, right.arguments);
}

export function decideToolCallRequest(input: {
  requestedCall: ToolCallRequest;
  selectedToolNames: ReadonlySet<string>;
  selectedToolNamesList: readonly string[];
  selectedToolByName: ReadonlyMap<string, ToolLike>;
  toolSelectionPromptText?: string;
  lastCompletedCall?: ToolCallRequest;
  lastObservation?: ToolExecutionObservation;
  canRepair: boolean;
  canRecoverRepeated?: boolean;
  discoveryToolNames?: readonly string[];
}): ToolCallDecision {
  const {
    requestedCall,
    selectedToolNames,
    selectedToolNamesList,
    selectedToolByName,
    canRepair,
  } = input;

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
        argumentValidationWarnings: argumentValidation.warnings,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 请求了参数不符合 schema 的工具调用：${requestedCall.name}。\n\n` +
        `参数错误：${argumentValidation.errors.join("; ")}`,
      toolName: requestedCall.name,
      errors: argumentValidation.errors,
      argumentValidationWarnings: argumentValidation.warnings,
    };
  }

  const shellCommandGuard = validateShellCommandRequest({
    requestedCall,
    toolSelectionPromptText: input.toolSelectionPromptText,
    selectedToolNames: selectedToolNamesList,
  });
  if (!shellCommandGuard.ok) {
    if (canRepair) {
      return {
        kind: "repair",
        event: "recovery.shell_command_mismatch",
        prompt: buildShellCommandMismatchRepairPrompt({
          code: shellCommandGuard.code,
          reason: shellCommandGuard.reason,
          command: shellCommandGuard.command,
          errors: shellCommandGuard.errors,
          selectedToolNames: selectedToolNamesList,
        }),
        toolName: requestedCall.name,
        errors: shellCommandGuard.errors,
        argumentValidationWarnings: argumentValidation.warnings,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 检测到不安全或不匹配的 shell 工具调用：${requestedCall.name}。\n\n` +
        `原因：${shellCommandGuard.reason}\n\n` +
        `请改用 bash-compatible 命令，或显式调用 powershell.exe/pwsh 并正确引用路径。`,
      toolName: requestedCall.name,
      errors: shellCommandGuard.errors,
      argumentValidationWarnings: argumentValidation.warnings,
    };
  }

  if (input.lastObservation) {
    const repeatDecision = repeatPolicyForObservation(input.lastObservation);
    if (repeatDecision.allow) {
      return {
        kind: "accept",
        argumentValidationWarnings: argumentValidation.warnings,
        repeatPolicyDecision: repeatDecision,
      };
    }

    if (input.canRecoverRepeated ?? canRepair) {
      return {
        kind: "repair",
        event: "recovery.repeated_tool",
        prompt: buildRepeatedToolRepairPrompt(requestedCall.name, {
          status: input.lastObservation.status,
          errorCode: input.lastObservation.errorCode,
          reason: repeatDecision.reason,
          discoveryToolNames: input.discoveryToolNames,
        }),
        toolName: requestedCall.name,
      };
    }

    return {
      kind: "final",
      text:
        `xtalpi-pi-tools 检测到模型重复请求同一个工具，并拒绝再次执行：${requestedCall.name}。\n\n` +
        `上次状态：${input.lastObservation.status}` +
        `${input.lastObservation.errorCode ? `（${input.lastObservation.errorCode}）` : ""}。` +
        "该调用的重复策略为 same_call_forbidden。请使用已有结果、改用不同发现路径，或把任务拆小后重试。",
      toolName: requestedCall.name,
    };
  }

  if (input.lastCompletedCall && sameToolCall(input.lastCompletedCall, requestedCall)) {
    if (input.canRecoverRepeated ?? canRepair) {
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

  return { kind: "accept", argumentValidationWarnings: argumentValidation.warnings };
}
