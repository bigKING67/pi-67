import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildBrowserMcpReadinessFinal,
  detectBrowserMcpTaskText,
  preferredBrowserMcpToolName,
  selectedBrowserMcpToolName,
} from "../browser-bridge.ts";
import { debugLog } from "../diagnostics.ts";
import type { XtalpiProviderTurnResult } from "../output-message.ts";
import type { XtalpiChatMessage } from "../protocol.ts";
import { resolveProviderRuntimePolicy } from "../runtime-config.ts";
import type { RuntimePolicy } from "../config/runtime-policy.ts";
import {
  contentToText,
  isContinuationPrompt,
  serializeContextForXtalpi,
  type ContextLike,
  type SerializedXtalpiContext,
} from "../serializer.ts";
import { latestToolCallWithResult } from "../tool-call-history.ts";
import type { ToolLike } from "../tools/types.ts";
import { pathDiscoveryToolNames } from "../tools/repeat-policy.ts";
import {
  buildTurnDebugContext,
  type TurnDebugContext,
} from "../turn-debug-context.ts";
import {
  buildToolExecutionLedger,
  type ToolExecutionLedger,
} from "./tool-execution-ledger.ts";
import {
  buildVisionBridgeReadinessFinal,
  detectVisionTaskText,
  preferredVisionToolName,
  selectedVisionToolName,
  type VisionTaskDetection,
} from "../vision-bridge.ts";

export type PreparedProviderTurn = {
  policy: RuntimePolicy;
  contextLike: ContextLike;
  toolLedger: ToolExecutionLedger;
  serializedContext: SerializedXtalpiContext;
  names: ReadonlySet<string>;
  selectedToolByName: Map<string, ToolLike>;
  messages: XtalpiChatMessage[];
  lastCompletedCall: ToolCall | undefined;
  debugContext: TurnDebugContext;
  selectedToolNames: string[];
  visionDetection: VisionTaskDetection;
  selectedVisionTool: string | undefined;
};

export type ProviderTurnPreparationResult =
  | { kind: "ready"; state: PreparedProviderTurn }
  | { kind: "final"; result: XtalpiProviderTurnResult };

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
} as const;

export function prepareProviderTurn(input: {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
}): ProviderTurnPreparationResult {
  const { model, context, options } = input;
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
    policy,
    ...(options ? { options } : {}),
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
  const availableToolNames = [...availableContextToolNames];
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
      result: {
        kind: "final",
        text: buildVisionBridgeReadinessFinal({
          detection: visionDetection,
          availableToolNames,
          selectedToolNames,
          maxTools,
          ...(preferredVisionTool === undefined ? {} : { preferredToolName: preferredVisionTool }),
        }),
        usage: ZERO_USAGE,
      },
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
      result: {
        kind: "final",
        text: buildBrowserMcpReadinessFinal({
          detection: browserDetection,
          availableToolNames,
          selectedToolNames,
          maxTools,
          ...(preferredBrowserTool === undefined ? {} : { preferredToolName: preferredBrowserTool }),
        }),
        usage: ZERO_USAGE,
      },
    };
  }

  return {
    kind: "ready",
    state: {
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
    },
  };
}
