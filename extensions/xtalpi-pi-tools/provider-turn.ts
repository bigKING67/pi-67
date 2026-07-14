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
  type XtalpiChatMessage,
} from "./protocol.ts";
import { buildParseErrorRepairPlan, parseErrorRecoveryBudget } from "./recovery-decision.ts";
import {
  buildEmptyResponseRepairPrompt,
} from "./turn/recovery-prompts.ts";
import type { ProviderRuntimeConfig } from "./runtime-config.ts";
import type { RuntimePolicy } from "./config/runtime-policy.ts";
import { safeBlockText } from "./text-safety.ts";
import { decideToolCallRequest } from "./tool-call-decision.ts";
import { makeRequestedToolCall } from "./tool-call-history.ts";
import { latestObservationForCall } from "./turn/tool-execution-ledger.ts";
import { pathDiscoveryToolNames } from "./tools/repeat-policy.ts";
import { TurnLoopState } from "./turn-loop-state.ts";
import { canAcceptImmediatePostToolPlainFinal, decideFinalGuardPolicy, decideVisionInability } from "./turn/provider-final-policy.ts";
import { prepareProviderTurn } from "./turn/provider-turn-preparation.ts";

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
  const preparation = prepareProviderTurn({
    model,
    context,
    ...(options ? { options } : {}),
  });
  if (preparation.kind === "final") return preparation.result;

  const {
    policy,
    contextLike,
    toolLedger,
    serializedContext,
    names,
    selectedToolByName,
    messages,
    lastCompletedCall,
    debugContext,
    selectedToolNames,
    visionDetection,
    selectedVisionTool,
  } = preparation.state;

  const loopState = new TurnLoopState();

  // Recovery turns must stay serial: each repair prompt depends on the exact
  // previous model response and on the current per-turn recovery budget.
  while (true) {
    const response = await callChat({
      model,
      messages,
      policy,
      ...(options ? { options } : {}),
      ...(runtimeConfig ? { runtimeConfig } : {}),
    });
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

    const parsed = parseJsonAction(raw, { selectedToolNames });
    if (parsed.kind === "error") {
      const visionDecision = decideVisionInability({
        detection: visionDetection,
        ...(selectedVisionTool === undefined ? {} : { selectedVisionTool }),
        text: raw,
        latestUserText: serializedContext.toolSelectionPromptText,
        canRecover: loopState.canRecoverFinal(debugContext),
      });
      if (visionDecision.kind === "recover") {
        const recovery = loopState.noteFinalRecovery();
        messages.push({ role: "user", content: visionDecision.prompt });
        debugLog("recovery.vision_bridge_tool_not_called", {
          ...debugContext,
          toolName: visionDecision.toolName,
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
      const finalPolicy = decideFinalGuardPolicy({
        guard: parseErrorFinalGuard,
        raw,
        selectedToolNames,
        canRecover:
          parsed.code === "invalid_json" &&
          !raw.trim().startsWith("{") &&
          loopState.canRecoverFinal(debugContext),
      });
      if (finalPolicy.kind === "recover") {
        const recovery = loopState.noteFinalRecovery();
        messages.push({ role: "user", content: finalPolicy.prompt });
        debugLog("recovery.premature_final", {
          ...debugContext,
          code: finalPolicy.violation.code,
          reason: finalPolicy.violation.reason,
          ...recovery,
          rawExcerpt: safeBlockText(raw, 500),
        });
        continue;
      }

      const latestObservation = toolLedger.latestObservation;
      if (canAcceptImmediatePostToolPlainFinal({
        parseErrorCode: parsed.code,
        raw,
        finalPolicy,
        toolLedger,
        contextMessageCount: contextLike.messages.length,
        totalRecoveries: loopState.snapshot().totalRecoveries,
      })) {
        debugLog("final.post_tool_plain_text_accepted", {
          ...debugContext,
          toolName: latestObservation?.toolCall.name,
          priorToolStatus: latestObservation?.status,
          toolFingerprint: latestObservation?.fingerprint,
          rawExcerpt: safeBlockText(raw, 500),
        });
        return {
          kind: "final",
          text: raw,
          ...loopState.resultFields(),
        };
      }

      const recoveryBudget = parseErrorRecoveryBudget(parsed);
      const canRecoverParseError = recoveryBudget === "repair" ? loopState.canRecoverRepair(debugContext) : loopState.canRecoverFormat(debugContext);
      if (canRecoverParseError) {
        const recovery = recoveryBudget === "repair" ? loopState.noteRepairRecovery() : loopState.noteFormatRecovery();
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

      if (visionDecision.kind === "final") {
        return {
          kind: "final",
          text: visionDecision.text,
          ...loopState.resultFields(),
        };
      }

      if (finalPolicy.kind === "fallback") {
        debugLog("recovery.plan_mode_fallback", {
          ...debugContext,
          code: finalPolicy.violation.code,
          reason: finalPolicy.violation.reason,
          ...loopState.snapshot(),
          rawExcerpt: safeBlockText(raw, 500),
        });
        return {
          kind: "final",
          text: finalPolicy.text,
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
      const visionDecision = decideVisionInability({
        detection: visionDetection,
        ...(selectedVisionTool === undefined ? {} : { selectedVisionTool }),
        text: parsed.text,
        latestUserText: serializedContext.toolSelectionPromptText,
        canRecover: loopState.canRecoverFinal(debugContext),
      });
      if (visionDecision.kind === "recover") {
        const recovery = loopState.noteFinalRecovery();
        messages.push({ role: "user", content: visionDecision.prompt });
        debugLog("recovery.vision_bridge_tool_not_called", {
          ...debugContext,
          toolName: visionDecision.toolName,
          code: "vision_bridge_tool_not_called",
          ...recovery,
          rawExcerpt: safeBlockText(raw, 500),
        });
        continue;
      }
      if (visionDecision.kind === "final") {
        return {
          kind: "final",
          text: visionDecision.text,
          ...loopState.resultFields(),
        };
      }

      const finalGuard = validateFinalAnswer({
        text: parsed.text,
        context: contextLike,
        selectedToolNames,
      });
      const finalPolicy = decideFinalGuardPolicy({
        guard: finalGuard,
        raw,
        selectedToolNames,
        canRecover: loopState.canRecoverFinal(debugContext),
      });
      if (finalPolicy.kind === "recover") {
        const recovery = loopState.noteFinalRecovery();
        messages.push({ role: "user", content: finalPolicy.prompt });
        debugLog("recovery.premature_final", {
          ...debugContext,
          code: finalPolicy.violation.code,
          reason: finalPolicy.violation.reason,
          ...recovery,
          rawExcerpt: safeBlockText(raw, 500),
        });
        continue;
      }
      if (finalPolicy.kind === "fallback") {
        debugLog("recovery.plan_mode_fallback", {
          ...debugContext,
          code: finalPolicy.violation.code,
          reason: finalPolicy.violation.reason,
          ...loopState.snapshot(),
          rawExcerpt: safeBlockText(raw, 500),
        });
        return {
          kind: "final",
          text: finalPolicy.text,
          ...loopState.resultFields(),
        };
      }
      if (finalPolicy.kind === "reject") {
        return {
          kind: "final",
          text: finalPolicy.text,
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
        ? matchingObservation ? { lastObservation: matchingObservation } : {}
        : lastCompletedCall ? { lastCompletedCall } : {}),
    });
    if (policy.engine === "shadow") {
      const shadowDecision = decideToolCallRequest({
        ...decisionInput,
        ...(matchingObservation ? { lastObservation: matchingObservation } : {}),
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
