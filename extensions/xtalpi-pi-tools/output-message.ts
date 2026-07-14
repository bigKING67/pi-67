import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { debugLog, safeErrorMessage } from "./diagnostics.ts";
import { toErrorTelemetry } from "./errors.ts";
import {
  EMPTY_USAGE,
  PROVIDER_ID,
  type UsageSummary,
} from "./protocol.ts";
import { toPiUsage } from "./response-normalizer.ts";
import {
  emitTextBlock,
  emitToolCallBlock,
} from "./stream.ts";

export type XtalpiProviderTurnResult =
  | {
      kind: "final";
      text: string;
      usage: UsageSummary;
      responseModel?: string;
    }
  | {
      kind: "tool_call";
      toolCall: ToolCall;
      leadingText: string;
      trailingText: string;
      usage: UsageSummary;
      responseModel?: string;
    };

export function createOutputMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: toPiUsage(EMPTY_USAGE),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function startOutputMessage(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): AssistantMessage {
  const output = createOutputMessage(model);
  stream.push({ type: "start", partial: output });
  return output;
}

export function finishOutputWithTurnResult(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  result: XtalpiProviderTurnResult,
): void {
  output.usage = toPiUsage(result.usage);
  if (result.responseModel) output.responseModel = result.responseModel;

  if (result.kind === "tool_call") {
    if (result.leadingText) emitTextBlock(stream, output, result.leadingText);
    emitToolCallBlock(stream, output, result.toolCall);
    if (result.trailingText) emitTextBlock(stream, output, result.trailingText);
    output.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message: output });
    return;
  }

  emitTextBlock(stream, output, result.text);
  output.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: output });
}

export function finishOutputWithError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  input: {
    error: unknown;
    model: Pick<Model<Api>, "id">;
    aborted: boolean;
  },
): void {
  output.stopReason = input.aborted ? "aborted" : "error";
  output.errorMessage = safeErrorMessage(input.error);
  debugLog("error.provider", {
    provider: PROVIDER_ID,
    model: input.model.id,
    ...toErrorTelemetry(input.error),
  });
  stream.push({ type: "error", reason: output.stopReason, error: output });
}
