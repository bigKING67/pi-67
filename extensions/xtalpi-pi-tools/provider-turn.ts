import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  callXtalpiChat,
  type XtalpiChatResponse,
} from "./chat-client.ts";
import { debugLog } from "./diagnostics.ts";
import type { ArgumentValidationWarning } from "./argument-validator.ts";
import type { XtalpiProviderTurnResult } from "./output-message.ts";
import { parseToolCall } from "./parser.ts";
import { validateFinalAnswer } from "./final-guard.ts";
import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOLS,
  type XtalpiChatMessage,
} from "./protocol.ts";
import { buildParseErrorRepairPlan } from "./recovery-decision.ts";
import {
  buildEmptyResponseRepairPrompt,
  buildPrematureFinalRepairPrompt,
  envInt,
} from "./retry.ts";
import type { ProviderRuntimeConfig } from "./runtime-config.ts";
import {
  serializeContextForXtalpi,
  type ContextLike,
} from "./serializer.ts";
import { safeBlockText } from "./text-safety.ts";
import { decideToolCallRequest } from "./tool-call-decision.ts";
import {
  latestToolCallWithResult,
  makeRequestedToolCall,
} from "./tool-call-history.ts";
import { buildTurnDebugContext } from "./turn-debug-context.ts";
import { TurnLoopState } from "./turn-loop-state.ts";

export type ProviderTurnChatClient = (input: {
  model: Model<Api>;
  messages: XtalpiChatMessage[];
  options?: SimpleStreamOptions;
  runtimeConfig?: ProviderRuntimeConfig;
}) => Promise<XtalpiChatResponse>;

function argumentValidationTelemetry(warnings: readonly ArgumentValidationWarning[] | undefined): {
  argumentValidationWarningCount: number;
  argumentValidationWarningCodes: string[];
  argumentValidationWarnings: readonly ArgumentValidationWarning[];
} {
  const safeWarnings = warnings ?? [];
  return {
    argumentValidationWarningCount: safeWarnings.length,
    argumentValidationWarningCodes: [...new Set(safeWarnings.map((warning) => warning.code))].sort(),
    argumentValidationWarnings: safeWarnings,
  };
}

export async function runProviderTurn(input: {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
  runtimeConfig?: ProviderRuntimeConfig;
  callChat?: ProviderTurnChatClient;
}): Promise<XtalpiProviderTurnResult> {
  const { model, context, options, runtimeConfig } = input;
  const callChat = input.callChat ?? callXtalpiChat;
  const maxTools = envInt("XTALPI_PI_TOOLS_MAX_TOOLS", DEFAULT_MAX_TOOLS, 0);
  const maxToolResultChars = envInt(
    "XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS",
    DEFAULT_MAX_TOOL_RESULT_CHARS,
    0,
  );
  const contextLike = context as unknown as ContextLike;
  const serializedContext = serializeContextForXtalpi(contextLike, { maxTools, maxToolResultChars });
  const names = serializedContext.selectedToolNames;
  const selectedToolByName = new Map(serializedContext.selectedTools.map((tool) => [tool.name, tool]));
  const messages = serializedContext.messages;
  const lastCompletedCall = latestToolCallWithResult(contextLike);
  const debugContext = buildTurnDebugContext({
    model,
    context: contextLike,
    serializedContext,
    maxTools,
    maxToolResultChars,
    options,
  });
  const selectedToolNames = debugContext.selectedToolNames;
  debugLog("turn.start", debugContext);

  const loopState = new TurnLoopState();

  // Recovery turns must stay serial: each repair prompt depends on the exact
  // previous model response and on the current per-turn recovery budget.
  while (true) {
    const response = await callChat({ model, messages, options, runtimeConfig });
    loopState.addResponse(response);
    const raw = response.content.trim();

    if (!raw) {
      if (loopState.canRecoverEmptyResponse(debugContext)) {
        const recovery = loopState.noteEmptyRecovery();
        messages.push({ role: "user", content: buildEmptyResponseRepairPrompt() });
        debugLog("recovery.empty_response", { ...debugContext, ...recovery });
        continue;
      }

      return {
        kind: "final",
        text:
          "xtalpi-pi-tools 收到连续空响应，已停止自动重试以避免卡死。请重发上一句，或降低任务复杂度后继续。",
        ...loopState.resultFields(),
      };
    }

    const parsed = parseToolCall(raw);
    if (parsed.kind === "error") {
      if (loopState.canRecoverRepair(debugContext)) {
        const recovery = loopState.noteRepairRecovery();
        const repairPlan = buildParseErrorRepairPlan(parsed, selectedToolNames);
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({ role: "user", content: repairPlan.prompt });
        debugLog(repairPlan.event, {
          ...debugContext,
          code: parsed.code,
          ...recovery,
          rawExcerpt: safeBlockText(parsed.raw, 500),
        });
        continue;
      }

      return {
        kind: "final",
        text: `xtalpi-pi-tools 无法解析模型返回的工具调用，已停止自动修复。\n\n解析错误：${parsed.message}\n\n模型原始输出摘录：\n${raw.slice(0, 2000)}`,
        ...loopState.resultFields(),
      };
    }

    if (parsed.kind === "none") {
      const finalGuard = validateFinalAnswer({
        text: parsed.text,
        context: contextLike,
        selectedToolNames,
      });
      if (!finalGuard.ok) {
        if (loopState.canRecoverRepair(debugContext)) {
          const recovery = loopState.noteRepairRecovery();
          messages.push({ role: "assistant", content: raw.slice(0, 4000) });
          messages.push({
            role: "user",
            content: buildPrematureFinalRepairPrompt({
              code: finalGuard.code,
              reason: finalGuard.reason,
              raw,
              latestUserText: finalGuard.latestUserText,
              availableNames: selectedToolNames,
            }),
          });
          debugLog("recovery.premature_final", {
            ...debugContext,
            code: finalGuard.code,
            reason: finalGuard.reason,
            ...recovery,
            rawExcerpt: safeBlockText(raw, 500),
          });
          continue;
        }

        return {
          kind: "final",
          text:
            `xtalpi-pi-tools 检测到模型返回疑似未完成的最终回答，已停止自动修复。\n\n` +
            `原因：${finalGuard.reason}\n\n模型原始输出摘录：\n${raw.slice(0, 2000)}`,
          ...loopState.resultFields(),
        };
      }

      return {
        kind: "final",
        text: parsed.text,
        ...loopState.resultFields(),
      };
    }

    const requestedCall = makeRequestedToolCall(parsed.call.name, parsed.call.arguments);

    const toolDecision = decideToolCallRequest({
      requestedCall,
      selectedToolNames: names,
      selectedToolNamesList: selectedToolNames,
      selectedToolByName,
      lastCompletedCall,
      canRepair: loopState.canRecoverRepair(debugContext),
    });

    if (toolDecision.kind === "repair") {
      const recovery = loopState.noteRepairRecovery();
      messages.push({ role: "assistant", content: raw.slice(0, 4000) });
      messages.push({ role: "user", content: toolDecision.prompt });
      debugLog(toolDecision.event, {
        ...debugContext,
        toolName: toolDecision.toolName,
        errors: toolDecision.errors,
        ...argumentValidationTelemetry(toolDecision.argumentValidationWarnings),
        ...recovery,
      });
      continue;
    }

    if (toolDecision.kind === "final") {
      return {
        kind: "final",
        text: toolDecision.text,
        ...loopState.resultFields(),
      };
    }

    debugLog("tool_call", {
      ...debugContext,
      toolName: requestedCall.name,
      argsKeys: Object.keys(requestedCall.arguments),
      warnings: parsed.warnings,
      ...argumentValidationTelemetry(toolDecision.argumentValidationWarnings),
    });

    return {
      kind: "tool_call",
      toolCall: requestedCall,
      leadingText: parsed.before,
      trailingText: parsed.after,
      ...loopState.resultFields(),
    };
  }
}
