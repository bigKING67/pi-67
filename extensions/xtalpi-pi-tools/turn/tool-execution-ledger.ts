import { createHash } from "node:crypto";
import type { ToolCall } from "@earendil-works/pi-ai";
import { stableCanonicalJson } from "../json-utils.ts";
import type { JsonObject } from "../protocol.ts";
import {
  contentToText,
  type MessageLike,
} from "../protocol/message-content.ts";

export type ToolExecutionStatus =
  | "success"
  | "deterministic_error"
  | "transient_error"
  | "unknown_error"
  | "cancelled";

export type ToolExecutionObservation = {
  toolCall: ToolCall;
  fingerprint: string;
  status: ToolExecutionStatus;
  errorCode?: string;
  resultMessageIndex: number;
  resultToolName: string | undefined;
  resultContent: string;
  sameFingerprintExecutionCount: number;
  toolNameMismatch: boolean;
};

export type ToolExecutionLedger = {
  schema: "xtalpi-pi-tools.tool-execution-ledger.v2";
  observations: ToolExecutionObservation[];
  latestObservation: ToolExecutionObservation | undefined;
  pendingCallCount: number;
  unpairedResultCount: number;
  duplicateResultCount: number;
};

const DETERMINISTIC_ERROR_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "HTTP_400",
  "HTTP_401",
  "HTTP_403",
  "HTTP_404",
  "HTTP_405",
  "HTTP_409",
  "HTTP_410",
  "HTTP_422",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "HTTP_408",
  "HTTP_425",
  "HTTP_429",
  "HTTP_500",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallFromBlock(block: Record<string, unknown>): ToolCall | undefined {
  if (block.type !== "toolCall" || typeof block.name !== "string") return undefined;
  return {
    type: "toolCall",
    id: typeof block.id === "string" ? block.id : "",
    name: block.name,
    arguments: isObject(block.arguments) ? block.arguments : {},
  };
}

export function toolCallFingerprint(input: {
  name: string;
  arguments: JsonObject;
}): string {
  const digest = createHash("sha256")
    .update(input.name)
    .update("\n")
    .update(stableCanonicalJson(input.arguments))
    .digest("hex");
  return `sha256:${digest}`;
}

export function extractToolResultErrorCode(content: string): string | undefined {
  const errno = content.match(
    /\b(EACCES|EEXIST|EISDIR|EINVAL|ENAMETOOLONG|ENOENT|ENOTDIR|ENOTEMPTY|EPERM|EROFS|EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|EPIPE|ETIMEDOUT)\b/i,
  )?.[1];
  if (errno) return errno.toUpperCase();

  const httpStatus = content.match(/(?:HTTP(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*([45][0-9]{2})\b/i)?.[1];
  if (httpStatus) return `HTTP_${httpStatus}`;

  if (/no such file or directory|cannot find (?:the )?(?:file|path)|file not found/i.test(content)) return "ENOENT";
  if (/permission denied|access is denied/i.test(content)) return "EACCES";
  if (/timed?\s*out|timeout/i.test(content)) return "ETIMEDOUT";
  if (/rate[ -]?limit|too many requests/i.test(content)) return "HTTP_429";
  if (/temporar(?:y|ily) unavailable|service unavailable/i.test(content)) return "HTTP_503";
  return undefined;
}

export function classifyToolResultStatus(input: {
  isError: boolean;
  content: string;
}): { status: ToolExecutionStatus; errorCode?: string } {
  if (!input.isError) return { status: "success" };
  if (/\b(?:cancelled|canceled|aborted|interrupted)\b/i.test(input.content)) {
    return { status: "cancelled", errorCode: "CANCELLED" };
  }

  const errorCode = extractToolResultErrorCode(input.content);
  if (errorCode && DETERMINISTIC_ERROR_CODES.has(errorCode)) {
    return { status: "deterministic_error", errorCode };
  }
  if (errorCode && TRANSIENT_ERROR_CODES.has(errorCode)) {
    return { status: "transient_error", errorCode };
  }
  return { status: "unknown_error", ...(errorCode ? { errorCode } : {}) };
}

export function buildToolExecutionLedger(context: { messages: MessageLike[] }): ToolExecutionLedger {
  const callsById = new Map<string, ToolCall>();
  const completedCallIds = new Set<string>();
  const fingerprintCounts = new Map<string, number>();
  const observations: ToolExecutionObservation[] = [];
  let unpairedResultCount = 0;
  let duplicateResultCount = 0;

  for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex += 1) {
    const message = context.messages[messageIndex];
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isObject(block)) continue;
        const toolCall = toolCallFromBlock(block);
        if (toolCall?.id) callsById.set(toolCall.id, toolCall);
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    const toolCall = toolCallId ? callsById.get(toolCallId) : undefined;
    if (!toolCall) {
      unpairedResultCount += 1;
      continue;
    }
    if (completedCallIds.has(toolCallId)) {
      duplicateResultCount += 1;
      continue;
    }

    completedCallIds.add(toolCallId);
    const resultContent = contentToText(message.content);
    const classified = classifyToolResultStatus({
      isError: message.isError === true,
      content: resultContent,
    });
    const fingerprint = toolCallFingerprint(toolCall);
    const sameFingerprintExecutionCount = (fingerprintCounts.get(fingerprint) ?? 0) + 1;
    fingerprintCounts.set(fingerprint, sameFingerprintExecutionCount);
    observations.push({
      toolCall,
      fingerprint,
      ...classified,
      resultMessageIndex: messageIndex,
      resultToolName: typeof message.toolName === "string" ? message.toolName : undefined,
      resultContent,
      sameFingerprintExecutionCount,
      toolNameMismatch: typeof message.toolName === "string" && message.toolName !== toolCall.name,
    });
  }

  return {
    schema: "xtalpi-pi-tools.tool-execution-ledger.v2",
    observations,
    latestObservation: observations.at(-1),
    pendingCallCount: Math.max(0, callsById.size - completedCallIds.size),
    unpairedResultCount,
    duplicateResultCount,
  };
}

export function latestObservationForCall(
  ledger: ToolExecutionLedger,
  toolCall: Pick<ToolCall, "name" | "arguments">,
): ToolExecutionObservation | undefined {
  const fingerprint = toolCallFingerprint({
    name: toolCall.name,
    arguments: isObject(toolCall.arguments) ? toolCall.arguments : {},
  });
  for (let index = ledger.observations.length - 1; index >= 0; index -= 1) {
    const observation = ledger.observations[index];
    if (!observation) continue;
    if (observation.fingerprint === fingerprint) return observation;
  }
  return undefined;
}
