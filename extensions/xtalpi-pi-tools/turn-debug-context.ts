import { createHash } from "node:crypto";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  COMPATIBILITY_PROTOCOL_VERSION,
  PROVIDER_ID,
} from "./protocol.ts";
import {
  JSON_ACTION_PROTOCOL,
  JSON_ACTION_PROTOCOL_VERSION,
  jsonActionResponseFormat,
} from "./json-action-protocol.ts";
import {
  resolveMaxOutputTokens,
  resolveProviderRuntimePolicy,
} from "./runtime-config.ts";
import type { RuntimePolicy } from "./config/runtime-policy.ts";
import type {
  ContextLike,
  SerializedXtalpiContext,
} from "./serializer.ts";

export type TurnDebugContext = {
  provider: string;
  model: string;
  runtimeProfile: RuntimePolicy["profile"];
  runtimeEngine: RuntimePolicy["engine"];
  compatibilityProtocolVersion: string;
  protocolVersion: string;
  actionProtocol: typeof JSON_ACTION_PROTOCOL;
  responseFormat: string | null;
  selectedToolCount: number;
  selectedToolNames: string[];
  selectedToolNamesHash: string;
  availableToolCount: number;
  maxTools: number;
  toolSelectionClipped: boolean;
  toolSelectionOmittedCount: number;
  toolSelectionValidCount: number;
  toolSelectionPromptSource: SerializedXtalpiContext["toolSelectionPromptSource"];
  toolSelectionPromptChars: number;
  toolSelectionUserMessageCount: number;
  toolSelectionSummary: SerializedXtalpiContext["toolSelectionSummary"];
  toolResultReceiptVersion: SerializedXtalpiContext["toolResultReceiptVersion"];
  toolHistoryChars: number;
  toolHistoryOmittedCount: number;
  maxToolResultChars: number;
  maxToolHistoryChars: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  requestAttempts: number;
  perAttemptTimeoutMs: number;
  totalRequestDeadlineMs: number;
  maxResponseBytes: number;
  maxEmptyRetries: number;
  maxRepairRetries: number;
  maxTotalRecoveries: number;
  maxFormatRecoveries: number;
  maxFinalRecoveries: number;
  maxRepeatedCallRecoveries: number;
};

export function sortedToolNames(names: Iterable<string>): string[] {
  return [...names].sort();
}

export function hashSelectedToolNames(names: readonly string[]): string {
  return createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);
}

export function buildTurnDebugContext(input: {
  model: Model<Api>;
  context: ContextLike;
  serializedContext: SerializedXtalpiContext;
  maxTools: number;
  maxToolResultChars: number;
  options?: SimpleStreamOptions;
  policy?: RuntimePolicy;
}): TurnDebugContext {
  const selectedToolNames = sortedToolNames(input.serializedContext.selectedToolNames);
  const policy = input.policy ?? resolveProviderRuntimePolicy(input.options);

  return {
    provider: PROVIDER_ID,
    model: input.model.id,
    runtimeProfile: policy.profile,
    runtimeEngine: policy.engine,
    compatibilityProtocolVersion: COMPATIBILITY_PROTOCOL_VERSION,
    protocolVersion: JSON_ACTION_PROTOCOL_VERSION,
    actionProtocol: JSON_ACTION_PROTOCOL,
    responseFormat: jsonActionResponseFormat()?.type ?? null,
    selectedToolCount: input.serializedContext.selectedTools.length,
    selectedToolNames,
    selectedToolNamesHash: hashSelectedToolNames(selectedToolNames),
    availableToolCount: input.context.tools?.length ?? 0,
    maxTools: input.maxTools,
    toolSelectionClipped: input.serializedContext.toolSelectionSummary.clipped,
    toolSelectionOmittedCount: input.serializedContext.toolSelectionSummary.omittedToolCount,
    toolSelectionValidCount: input.serializedContext.toolSelectionSummary.validToolCount,
    toolSelectionPromptSource: input.serializedContext.toolSelectionPromptSource,
    toolSelectionPromptChars: input.serializedContext.toolSelectionPromptChars,
    toolSelectionUserMessageCount: input.serializedContext.toolSelectionUserMessageCount,
    toolSelectionSummary: input.serializedContext.toolSelectionSummary,
    toolResultReceiptVersion: input.serializedContext.toolResultReceiptVersion,
    toolHistoryChars: input.serializedContext.toolHistoryChars,
    toolHistoryOmittedCount: input.serializedContext.toolHistoryOmittedCount,
    maxToolResultChars: input.maxToolResultChars,
    maxToolHistoryChars: policy.maxToolHistoryChars,
    maxOutputTokens: resolveMaxOutputTokens(input.model, input.options, policy),
    requestTimeoutMs: policy.perAttemptTimeoutMs,
    requestAttempts: policy.requestAttempts,
    perAttemptTimeoutMs: policy.perAttemptTimeoutMs,
    totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
    maxResponseBytes: policy.maxResponseBytes,
    maxEmptyRetries: policy.maxEmptyRecoveries,
    maxRepairRetries: policy.maxRepairRecoveriesTotal,
    maxTotalRecoveries: policy.maxTotalRecoveries,
    maxFormatRecoveries: policy.maxFormatRecoveries,
    maxFinalRecoveries: policy.maxFinalRecoveries,
    maxRepeatedCallRecoveries: policy.maxRepeatedCallRecoveries,
  };
}
