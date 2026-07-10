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
  type XtalpiChatMessage,
} from "./protocol.ts";
import { buildParseErrorRepairPlan } from "./recovery-decision.ts";
import {
  buildEmptyResponseRepairPrompt,
  buildPrematureFinalRepairPrompt,
  buildPlanModeFallbackPlan,
} from "./retry.ts";
import {
  resolveProviderRuntimePolicy,
  type ProviderRuntimeConfig,
} from "./runtime-config.ts";
import type { RuntimePolicy } from "./config/runtime-policy.ts";
import {
  contentToText,
  isContinuationPrompt,
  serializeContextForXtalpi,
  type ContextLike,
} from "./serializer.ts";
import { safeBlockText } from "./text-safety.ts";
import { decideToolCallRequest } from "./tool-call-decision.ts";
import {
  latestToolCallWithResult,
  makeRequestedToolCall,
} from "./tool-call-history.ts";
import {
  buildToolExecutionLedger,
  latestObservationForCall,
} from "./turn/tool-execution-ledger.ts";
import { pathDiscoveryToolNames } from "./tools/repeat-policy.ts";
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
  policy?: RuntimePolicy;
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
  const policy = resolveProviderRuntimePolicy(options);
  const maxTools = policy.maxTools;
  const maxToolResultChars = policy.maxToolResultChars;
  const contextLike = context as unknown as ContextLike;
  const toolLedger = buildToolExecutionLedger(contextLike);
  const latestObservation = toolLedger.latestObservation;
  const latestMessage = contextLike.messages.at(-1);
  const latestMessageText = latestMessage?.role === "user" ? contentToText(latestMessage.content) : "";
  const recoveryContextActive = latestMessage?.role === "toolResult" || isContinuationPrompt(latestMessageText);
  const availableContextToolNames = (contextLike.tools ?? []).map((tool) => tool.name).filter(Boolean);
  const recoveryToolNames = policy.engine === "v2" &&
      recoveryContextActive &&
      latestObservation?.status === "deterministic_error" &&
      latestObservation.errorCode === "ENOENT"
    ? pathDiscoveryToolNames(availableContextToolNames, 2)
    : [];
  const serializedContext = serializeContextForXtalpi(contextLike, {
    maxTools,
    maxToolResultChars,
    maxToolHistoryChars: policy.maxToolHistoryChars,
    toolLedger,
    useToolResultReceiptV2: policy.engine === "v2",
    recoveryToolNames,
  });
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
    policy,
  });
  const selectedToolNames = debugContext.selectedToolNames;
  debugLog("turn.start", debugContext);
  debugLog("tool_ledger", {
    ...debugContext,
    ledgerSchema: toolLedger.schema,
    observationCount: toolLedger.observations.length,
    pendingCallCount: toolLedger.pendingCallCount,
    unpairedResultCount: toolLedger.unpairedResultCount,
    duplicateResultCount: toolLedger.duplicateResultCount,
    latestToolStatus: latestObservation?.status,
    latestToolErrorCode: latestObservation?.errorCode,
    latestToolFingerprint: latestObservation?.fingerprint,
    recoveryToolNames,
  });

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
    const response = await callChat({ model, messages, options, runtimeConfig, policy });
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
      if (
        visionDetection.isVisionTask &&
        selectedVisionTool &&
        isVisionInabilityFinal(raw) &&
        loopState.canRecoverFinal(debugContext)
      ) {
        const recovery = loopState.noteFinalRecovery();
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
        !parseErrorFinalGuard.ok &&
        loopState.canRecoverFinal(debugContext)
      ) {
        const recovery = loopState.noteFinalRecovery();
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

      if (loopState.canRecoverFormat(debugContext)) {
        const recovery = loopState.noteFormatRecovery();
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
        if (loopState.canRecoverFinal(debugContext)) {
          const recovery = loopState.noteFinalRecovery();
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
        if (loopState.canRecoverFinal(debugContext)) {
          const recovery = loopState.noteFinalRecovery();
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
    const matchingObservation = latestObservationForCall(toolLedger, requestedCall);
    const selectedDiscoveryToolNames = pathDiscoveryToolNames(names, 2);

    const decisionInput = {
      requestedCall,
      selectedToolNames: names,
      selectedToolNamesList: selectedToolNames,
      selectedToolByName,
      toolSelectionPromptText: serializedContext.toolSelectionPromptText,
      canRepair: loopState.canRecoverFormat(debugContext),
      canRecoverRepeated: loopState.canRecoverRepeatedCall(debugContext),
      discoveryToolNames: selectedDiscoveryToolNames,
    };
    const toolDecision = decideToolCallRequest({
      ...decisionInput,
      ...(policy.engine === "v2"
        ? { lastObservation: matchingObservation }
        : { lastCompletedCall }),
    });
    if (policy.engine === "shadow") {
      const shadowDecision = decideToolCallRequest({
        ...decisionInput,
        lastObservation: matchingObservation,
      });
      debugLog("tool_decision.shadow", {
        ...debugContext,
        toolName: requestedCall.name,
        legacyDecisionKind: toolDecision.kind,
        legacyDecisionEvent: toolDecision.kind === "repair" ? toolDecision.event : undefined,
        v2DecisionKind: shadowDecision.kind,
        v2DecisionEvent: shadowDecision.kind === "repair" ? shadowDecision.event : undefined,
        decisionsDiffer:
          toolDecision.kind !== shadowDecision.kind ||
          (toolDecision.kind === "repair" && shadowDecision.kind === "repair" && toolDecision.event !== shadowDecision.event),
        observationStatus: matchingObservation?.status,
        observationErrorCode: matchingObservation?.errorCode,
        observationFingerprint: matchingObservation?.fingerprint,
      });
    }

    if (toolDecision.kind === "repair") {
      const recovery = toolDecision.event === "recovery.repeated_tool"
        ? loopState.noteRepeatedCallRecovery()
        : loopState.noteFormatRecovery();
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
      repeatPolicy: toolDecision.repeatPolicyDecision?.policy,
      repeatReason: toolDecision.repeatPolicyDecision?.reason,
      priorToolStatus: matchingObservation?.status,
      priorToolErrorCode: matchingObservation?.errorCode,
      toolFingerprint: matchingObservation?.fingerprint,
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
