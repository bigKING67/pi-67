import { createHash } from "node:crypto";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  PROVIDER_ID,
} from "./protocol.ts";
import {
  JSON_ACTION_PROTOCOL,
  JSON_ACTION_PROTOCOL_VERSION,
  jsonActionResponseFormat,
} from "./json-action-protocol.ts";
import {
  maxEmptyRetries,
  maxRepairRetries,
  maxTotalRecoveries,
} from "./retry.ts";
import {
  resolveMaxOutputTokens,
  resolveRequestTimeoutMs,
} from "./runtime-config.ts";
import type {
  ContextLike,
  SerializedXtalpiContext,
} from "./serializer.ts";

export type TurnDebugContext = {
  provider: string;
  model: string;
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
  maxToolResultChars: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxEmptyRetries: number;
  maxRepairRetries: number;
  maxTotalRecoveries: number;
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
}): TurnDebugContext {
  const selectedToolNames = sortedToolNames(input.serializedContext.selectedToolNames);

  return {
    provider: PROVIDER_ID,
    model: input.model.id,
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
    maxToolResultChars: input.maxToolResultChars,
    maxOutputTokens: resolveMaxOutputTokens(input.model, input.options),
    requestTimeoutMs: resolveRequestTimeoutMs(input.options),
    maxEmptyRetries: maxEmptyRetries(),
    maxRepairRetries: maxRepairRetries(),
    maxTotalRecoveries: maxTotalRecoveries(),
  };
}
