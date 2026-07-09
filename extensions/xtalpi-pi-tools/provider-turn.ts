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
import { parseJsonAction } from "./parser.ts";
import { validateFinalAnswer } from "./final-guard.ts";
import {
  buildBrowserMcpReadinessFinal,
  detectBrowserMcpTaskText,
  preferredBrowserMcpToolName,
  selectedBrowserMcpToolName,
} from "./browser-bridge.ts";
import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOLS,
  type XtalpiChatMessage,
} from "./protocol.ts";
import { buildParseErrorRepairPlan } from "./recovery-decision.ts";
import {
  buildEmptyResponseRepairPrompt,
  buildPrematureFinalRepairPrompt,
  buildPlanModeFallbackPlan,
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
import {
  buildVisionBridgeReadinessFinal,
  buildVisionBridgeToolCallRepairPrompt,
  detectVisionTaskText,
  isVisionInabilityFinal,
  preferredVisionToolName,
  selectedVisionToolName,
} from "./vision-bridge.ts";

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

  const visionDetection = detectVisionTaskText(serializedContext.toolSelectionPromptText);
  const browserDetection = detectBrowserMcpTaskText(serializedContext.toolSelectionPromptText);
  const availableToolNames = [...(contextLike.tools ?? []).map((tool) => tool.name).filter(Boolean)];
  const preferredVisionTool = preferredVisionToolName(contextLike.tools);
  const selectedVisionTool = selectedVisionToolName(names);
  const preferredBrowserTool = preferredBrowserMcpToolName(contextLike.tools ?? []);
  const selectedBrowserTool = selectedBrowserMcpToolName(names);
  if (visionDetection.isVisionTask && !selectedVisionTool) {
    debugLog("vision_bridge.not_ready", {
      ...debugContext,
      visionReasonCodes: visionDetection.reasonCodes,
      imagePathCount: visionDetection.imagePaths.length,
      preferredVisionToolName: preferredVisionTool,
    });
    return {
      kind: "final",
      text: buildVisionBridgeReadinessFinal({
        detection: visionDetection,
        availableToolNames,
        selectedToolNames,
        maxTools,
        preferredToolName: preferredVisionTool,
      }),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    };
  }
  if (browserDetection.isBrowserMcpTask && !selectedBrowserTool) {
    debugLog("browser_mcp.not_ready", {
      ...debugContext,
      browserReasonCodes: browserDetection.reasonCodes,
      preferredBrowserToolName: preferredBrowserTool,
    });
    return {
      kind: "final",
      text: buildBrowserMcpReadinessFinal({
        detection: browserDetection,
        availableToolNames,
        selectedToolNames,
        maxTools,
        preferredToolName: preferredBrowserTool,
      }),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    };
  }

  const loopState = new TurnLoopState();

  function finalGuardRequiresPlanBlock(input: { code: string; reason: string }): boolean {
    return input.code === "plan_mode_contract_missing" ||
      /(?:Plan mode|<proposed_plan>)/i.test(input.reason);
  }

  function visionBridgeToolNotCalledFinalText(): string {
    return "xtalpi-pi-tools 检测到图片/截图任务，但模型没有调用本地 vision bridge，且自动修复预算已用尽。请重试上一句，或运行 pi-67 doctor 检查 vision_read/image_review 是否 ready。";
  }

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

    const parsed = parseJsonAction(raw);
    if (parsed.kind === "error") {
      if (loopState.canRecoverRepair(debugContext)) {
        if (
          visionDetection.isVisionTask &&
          selectedVisionTool &&
          isVisionInabilityFinal(raw)
        ) {
          const recovery = loopState.noteRepairRecovery();
          messages.push({
            role: "user",
            content: buildVisionBridgeToolCallRepairPrompt({
              toolName: selectedVisionTool,
              detection: visionDetection,
              latestUserText: serializedContext.toolSelectionPromptText,
            }),
          });
          debugLog("recovery.vision_bridge_tool_not_called", {
            ...debugContext,
            toolName: selectedVisionTool,
            code: "vision_bridge_tool_not_called",
            ...recovery,
            rawExcerpt: safeBlockText(raw, 500),
          });
          continue;
        }

        const parseErrorFinalGuard = validateFinalAnswer({
          text: raw,
          context: contextLike,
          selectedToolNames,
        });
        if (
          parsed.code === "invalid_json" &&
          !raw.trim().startsWith("{") &&
          !parseErrorFinalGuard.ok
        ) {
          const recovery = loopState.noteRepairRecovery();
          messages.push({
            role: "user",
            content: buildPrematureFinalRepairPrompt({
              code: parseErrorFinalGuard.code,
              reason: parseErrorFinalGuard.reason,
              raw,
              latestUserText: parseErrorFinalGuard.latestUserText,
              availableNames: selectedToolNames,
              forcePlanBlock: finalGuardRequiresPlanBlock(parseErrorFinalGuard),
            }),
          });
          debugLog("recovery.premature_final", {
            ...debugContext,
            code: parseErrorFinalGuard.code,
            reason: parseErrorFinalGuard.reason,
            ...recovery,
            rawExcerpt: safeBlockText(raw, 500),
          });
          continue;
        }

        const recovery = loopState.noteRepairRecovery();
        const repairPlan = buildParseErrorRepairPlan(parsed, selectedToolNames);
        messages.push({ role: "user", content: repairPlan.prompt });
        debugLog(repairPlan.event, {
          ...debugContext,
          code: parsed.code,
          ...recovery,
          rawExcerpt: safeBlockText(parsed.raw, 500),
        });
        continue;
      }

      if (
        visionDetection.isVisionTask &&
        selectedVisionTool &&
        isVisionInabilityFinal(raw)
      ) {
        return {
          kind: "final",
          text: visionBridgeToolNotCalledFinalText(),
          ...loopState.resultFields(),
        };
      }

      const parseErrorFinalGuard = validateFinalAnswer({
        text: raw,
        context: contextLike,
        selectedToolNames,
      });
      if (!parseErrorFinalGuard.ok && finalGuardRequiresPlanBlock(parseErrorFinalGuard)) {
        debugLog("recovery.plan_mode_fallback", {
          ...debugContext,
          code: parseErrorFinalGuard.code,
          reason: parseErrorFinalGuard.reason,
          ...loopState.snapshot(),
          rawExcerpt: safeBlockText(raw, 500),
        });
        return {
          kind: "final",
          text: buildPlanModeFallbackPlan({
            code: parseErrorFinalGuard.code,
            reason: parseErrorFinalGuard.reason,
            latestUserText: parseErrorFinalGuard.latestUserText,
          }),
          ...loopState.resultFields(),
        };
      }

      return {
        kind: "final",
        text: `xtalpi-pi-tools 无法解析模型返回的工具调用，已停止自动修复。\n\n解析错误：${parsed.message}\n\n模型原始输出摘录：\n${safeBlockText(raw, 2000)}`,
        ...loopState.resultFields(),
      };
    }

    if (parsed.kind === "none") {
      if (
        visionDetection.isVisionTask &&
        selectedVisionTool &&
        isVisionInabilityFinal(parsed.text)
      ) {
        if (loopState.canRecoverRepair(debugContext)) {
          const recovery = loopState.noteRepairRecovery();
          messages.push({
            role: "user",
            content: buildVisionBridgeToolCallRepairPrompt({
              toolName: selectedVisionTool,
              detection: visionDetection,
              latestUserText: serializedContext.toolSelectionPromptText,
            }),
          });
          debugLog("recovery.vision_bridge_tool_not_called", {
            ...debugContext,
            toolName: selectedVisionTool,
            code: "vision_bridge_tool_not_called",
            ...recovery,
            rawExcerpt: safeBlockText(raw, 500),
          });
          continue;
        }

        return {
          kind: "final",
          text: visionBridgeToolNotCalledFinalText(),
          ...loopState.resultFields(),
        };
      }

      const finalGuard = validateFinalAnswer({
        text: parsed.text,
        context: contextLike,
        selectedToolNames,
      });
      if (!finalGuard.ok) {
        if (loopState.canRecoverRepair(debugContext)) {
          const recovery = loopState.noteRepairRecovery();
          messages.push({
            role: "user",
            content: buildPrematureFinalRepairPrompt({
              code: finalGuard.code,
              reason: finalGuard.reason,
              raw,
              latestUserText: finalGuard.latestUserText,
              availableNames: selectedToolNames,
              forcePlanBlock: finalGuardRequiresPlanBlock(finalGuard),
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

        if (finalGuardRequiresPlanBlock(finalGuard)) {
          debugLog("recovery.plan_mode_fallback", {
            ...debugContext,
            code: finalGuard.code,
            reason: finalGuard.reason,
            ...loopState.snapshot(),
            rawExcerpt: safeBlockText(raw, 500),
          });
          return {
            kind: "final",
            text: buildPlanModeFallbackPlan({
              code: finalGuard.code,
              reason: finalGuard.reason,
              latestUserText: finalGuard.latestUserText,
            }),
            ...loopState.resultFields(),
          };
        }

        return {
          kind: "final",
          text:
            `xtalpi-pi-tools 检测到模型返回疑似未完成的最终回答，已停止自动修复。\n\n` +
            `原因：${finalGuard.reason}\n\n模型原始输出摘录：\n${safeBlockText(raw, 2000)}`,
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
      toolSelectionPromptText: serializedContext.toolSelectionPromptText,
      lastCompletedCall,
      canRepair: loopState.canRecoverRepair(debugContext),
    });

    if (toolDecision.kind === "repair") {
      const recovery = loopState.noteRepairRecovery();
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
