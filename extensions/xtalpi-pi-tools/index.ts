import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import { callXtalpiChat } from "./chat-client.ts";
import { debugLog } from "./diagnostics.ts";
import {
  finishOutputWithError,
  finishOutputWithTurnResult,
  startOutputMessage,
  type XtalpiProviderTurnResult,
} from "./output-message.ts";
import { parseToolCall } from "./parser.ts";
import {
  API_ID,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOLS,
  PROVIDER_ID,
  PROVIDER_NAME,
  type JsonObject,
} from "./protocol.ts";
import {
  buildEmptyResponseRepairPrompt,
  envInt,
} from "./retry.ts";
import { buildParseErrorRepairPlan } from "./recovery-decision.ts";
import {
  buildChatCompletionPayload,
  loadRuntimeConfig,
  resolveRequestTimeoutMs,
  type ProviderRuntimeConfig,
} from "./runtime-config.ts";
import {
  serializeContextForXtalpi,
  type ContextLike,
} from "./serializer.ts";
import { createLocalAssistantMessageEventStream } from "./stream.ts";
import { safeBlockText } from "./text-safety.ts";
import { decideToolCallRequest } from "./tool-call-decision.ts";
import { buildTurnDebugContext } from "./turn-debug-context.ts";
import { TurnLoopState } from "./turn-loop-state.ts";

let runtimeConfig: ProviderRuntimeConfig | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  buildChatCompletionPayload,
  resolveMaxOutputTokens,
  resolveRequestTimeoutMs,
} from "./runtime-config.ts";

function latestToolCallWithResult(context: ContextLike): ToolCall | undefined {
  let latestCall: ToolCall | undefined;
  let hasResultAfterLatestCall = false;

  for (const message of context.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "toolCall" && typeof block.name === "string") {
          latestCall = {
            type: "toolCall",
            id: typeof block.id === "string" ? block.id : "",
            name: block.name,
            arguments: isObject(block.arguments) ? block.arguments : {},
          };
          hasResultAfterLatestCall = false;
        }
      }
    } else if (message.role === "toolResult" && latestCall) {
      hasResultAfterLatestCall = true;
    }
  }

  return hasResultAfterLatestCall ? latestCall : undefined;
}

function makeToolCallId(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "tool";
  return `pi_tool_${safeName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeRequestedToolCall(name: string, args: JsonObject): ToolCall {
  return {
    type: "toolCall",
    id: makeToolCallId(name),
    name,
    arguments: args,
  };
}

async function runProviderTurn(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<XtalpiProviderTurnResult> {
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
    const response = await callXtalpiChat({ model, messages, options, runtimeConfig });
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

function streamXtalpiPiTools(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createLocalAssistantMessageEventStream();

  void (async () => {
    const output = startOutputMessage(stream, model);

    try {
      const result = await runProviderTurn(model, context, options);
      finishOutputWithTurnResult(stream, output, result);
    } catch (error) {
      finishOutputWithError(stream, output, {
        error,
        model,
        aborted: options?.signal?.aborted === true,
      });
    }
  })();

  return stream;
}

export default function xtalpiPiTools(pi: ExtensionAPI) {
  runtimeConfig = loadRuntimeConfig();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: runtimeConfig.baseUrl,
    apiKey: runtimeConfig.apiKey,
    api: API_ID,
    models: runtimeConfig.models,
    streamSimple: streamXtalpiPiTools,
  });
}
