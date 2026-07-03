import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "./argument-validator.ts";
import { debugLog, safeErrorMessage } from "./diagnostics.ts";
import {
  XtalpiProviderError,
  buildHttpError,
  buildProviderError,
  classifyTransportError,
  toErrorTelemetry,
} from "./errors.ts";
import { parseToolCall } from "./parser.ts";
import {
  API_ID,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOLS,
  EMPTY_USAGE,
  PROVIDER_ID,
  PROVIDER_NAME,
  type UsageSummary,
  type XtalpiChatMessage,
} from "./protocol.ts";
import {
  buildEmptyResponseRepairPrompt,
  buildFunctionStyleToolRepairPrompt,
  buildInvalidToolArgumentsRepairPrompt,
  buildInvalidToolJsonRepairPrompt,
  buildRawProtocolMarkupRepairPrompt,
  buildRepeatedToolRepairPrompt,
  buildUnknownToolRepairPrompt,
  envInt,
} from "./retry.ts";
import {
  addUsage,
  extractTextFromMessage,
  toPiUsage,
  usageFromResponse,
} from "./response-normalizer.ts";
import {
  buildChatCompletionPayload,
  endpointFor,
  isPlaceholderKey,
  loadRuntimeConfig,
  resolveRequestTimeoutMs,
  type ProviderRuntimeConfig,
} from "./runtime-config.ts";
import {
  serializeContextForXtalpi,
  type ContextLike,
} from "./serializer.ts";
import {
  createLocalAssistantMessageEventStream,
  emitTextBlock,
  emitToolCallBlock,
} from "./stream.ts";
import { safeBlockText } from "./text-safety.ts";
import { buildTurnDebugContext } from "./turn-debug-context.ts";

type ChatResponse = {
  content: string;
  usage: UsageSummary;
  responseModel?: string;
  finishReason?: string;
};

type ProviderTurnResult =
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

let runtimeConfig: ProviderRuntimeConfig | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  buildChatCompletionPayload,
  resolveMaxOutputTokens,
  resolveRequestTimeoutMs,
} from "./runtime-config.ts";

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason || new Error("aborted");
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw buildProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
    cause: abortReason(signal),
  });
}

type FetchTextResult = {
  response: Response;
  body: string;
};

async function readResponseTextWithAbort(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw abortReason(signal);

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortHandler = () => reject(abortReason(signal));
    removeAbortListener = () => signal.removeEventListener("abort", abortHandler);
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([response.text(), abortPromise]);
  } finally {
    removeAbortListener?.();
  }
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchTextResult> {
  throwIfCallerAborted(signal);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`xtalpi-pi-tools timeout after ${timeoutMs}ms`)), timeoutMs);
  const abortHandler = () => controller.abort(abortReason(signal));
  if (signal) signal.addEventListener("abort", abortHandler, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await readResponseTextWithAbort(response, controller.signal);
    return { response, body };
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortHandler);
  }
}

async function callXtalpiChat(
  model: Model<Api>,
  messages: XtalpiChatMessage[],
  options?: SimpleStreamOptions,
): Promise<ChatResponse> {
  throwIfCallerAborted(options?.signal);

  const apiKey = options?.apiKey || runtimeConfig?.apiKey || "";
  if (isPlaceholderKey(apiKey)) {
    throw buildProviderError(
      "api_key_missing",
      "xtalpi-pi-tools API key is not configured. Set XTALPI_PI_TOOLS_API_KEY or configure models.json providers.xtalpi-pi-tools.apiKey.",
    );
  }

  const payload = buildChatCompletionPayload(model, messages, options);
  const timeoutMs = resolveRequestTimeoutMs(options);
  debugLog("request", {
    provider: PROVIDER_ID,
    model: model.id,
    messageCount: payload.messages.length,
    maxTokens: payload.max_tokens,
    nativeToolsPresent: false,
    timeoutMs,
  });

  let response: Response;
  let body: string;
  try {
    ({ response, body } = await fetchTextWithTimeout(
      endpointFor(model, runtimeConfig),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(model.headers || {}),
          ...(options?.headers || {}),
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
      options?.signal,
    ));
  } catch (error) {
    if (error instanceof XtalpiProviderError) throw error;
    throw classifyTransportError(error, timeoutMs, options?.signal?.aborted === true);
  }

  if (!response.ok) {
    throw buildHttpError(response.status, body);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw buildProviderError(
      "non_json_response",
      `xtalpi-pi-tools returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`,
      {
        details: {
          bodyExcerpt: safeBlockText(body, 1000),
          bodyChars: body.length,
        },
        cause: error,
      },
    );
  }

  const root = isObject(json) ? json : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = choices.find(isObject);
  const message = isObject(firstChoice?.message) ? firstChoice.message : undefined;
  if (!message) {
    throw buildProviderError(
      "malformed_response",
      "xtalpi-pi-tools returned JSON without choices[].message",
      {
        details: {
          bodyExcerpt: safeBlockText(body, 1000),
          bodyChars: body.length,
        },
      },
    );
  }

  const content = extractTextFromMessage(message);
  const usage = usageFromResponse(root.usage);
  const responseModel = typeof root.model === "string" ? root.model : undefined;
  const finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined;

  debugLog("response", {
    provider: PROVIDER_ID,
    model: model.id,
    responseModel,
    finishReason,
    contentChars: content.length,
    usage,
  });

  return { content, usage, responseModel, finishReason };
}

function isSameToolCall(a: ToolCall, b: ToolCall): boolean {
  return a.name === b.name && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
}

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

async function runProviderTurn(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<ProviderTurnResult> {
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

  let emptyRetries = 0;
  let repairRetries = 0;
  let totalRecoveries = 0;
  let accumulatedUsage = { ...EMPTY_USAGE };
  let responseModel: string | undefined;

  // Recovery turns must stay serial: each repair prompt depends on the exact
  // previous model response and on the current per-turn recovery budget.
  while (true) {
    const response = await callXtalpiChat(model, messages, options);
    accumulatedUsage = addUsage(accumulatedUsage, response.usage);
    responseModel = response.responseModel || responseModel;
    const raw = response.content.trim();

    if (!raw) {
      if (emptyRetries < debugContext.maxEmptyRetries && totalRecoveries < debugContext.maxTotalRecoveries) {
        emptyRetries += 1;
        totalRecoveries += 1;
        messages.push({ role: "user", content: buildEmptyResponseRepairPrompt() });
        debugLog("recovery.empty_response", { ...debugContext, emptyRetries, totalRecoveries });
        continue;
      }

      return {
        kind: "final",
        text:
          "xtalpi-pi-tools 收到连续空响应，已停止自动重试以避免卡死。请重发上一句，或降低任务复杂度后继续。",
        usage: accumulatedUsage,
        responseModel,
      };
    }

    const parsed = parseToolCall(raw);
    if (parsed.kind === "error") {
      if (repairRetries < debugContext.maxRepairRetries && totalRecoveries < debugContext.maxTotalRecoveries) {
        repairRetries += 1;
        totalRecoveries += 1;
        const repairPrompt = parsed.code === "function_style_tool_call"
          ? buildFunctionStyleToolRepairPrompt(parsed.raw, selectedToolNames)
          : parsed.code === "raw_protocol_markup"
            ? buildRawProtocolMarkupRepairPrompt(parsed.raw, selectedToolNames)
            : buildInvalidToolJsonRepairPrompt(parsed.message, parsed.raw);
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({ role: "user", content: repairPrompt });
        const recoveryEvent = parsed.code === "function_style_tool_call"
          ? "recovery.function_style_tool_call"
          : parsed.code === "raw_protocol_markup"
            ? "recovery.raw_protocol_markup"
            : "recovery.invalid_tool_json";
        debugLog(recoveryEvent, {
          ...debugContext,
          code: parsed.code,
          repairRetries,
          totalRecoveries,
          rawExcerpt: safeBlockText(parsed.raw, 500),
        });
        continue;
      }

      return {
        kind: "final",
        text: `xtalpi-pi-tools 无法解析模型返回的工具调用，已停止自动修复。\n\n解析错误：${parsed.message}\n\n模型原始输出摘录：\n${raw.slice(0, 2000)}`,
        usage: accumulatedUsage,
        responseModel,
      };
    }

    if (parsed.kind === "none") {
      return {
        kind: "final",
        text: parsed.text,
        usage: accumulatedUsage,
        responseModel,
      };
    }

    const requestedCall: ToolCall = {
      type: "toolCall",
      id: makeToolCallId(parsed.call.name),
      name: parsed.call.name,
      arguments: parsed.call.arguments,
    };

    if (names.size === 0 || !names.has(requestedCall.name)) {
      if (repairRetries < debugContext.maxRepairRetries && totalRecoveries < debugContext.maxTotalRecoveries) {
        repairRetries += 1;
        totalRecoveries += 1;
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({ role: "user", content: buildUnknownToolRepairPrompt(requestedCall.name, selectedToolNames) });
        debugLog("recovery.unknown_tool", {
          ...debugContext,
          toolName: requestedCall.name,
          repairRetries,
          totalRecoveries,
        });
        continue;
      }

      return {
        kind: "final",
        text: `xtalpi-pi-tools 请求了不可用工具：${requestedCall.name}。本轮可用工具：${selectedToolNames.join(", ") || "(none)"}`,
        usage: accumulatedUsage,
        responseModel,
      };
    }

    const argumentValidation = validateToolArguments(selectedToolByName.get(requestedCall.name), requestedCall.arguments);
    if (!argumentValidation.ok) {
      if (repairRetries < debugContext.maxRepairRetries && totalRecoveries < debugContext.maxTotalRecoveries) {
        repairRetries += 1;
        totalRecoveries += 1;
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({
          role: "user",
          content: buildInvalidToolArgumentsRepairPrompt(requestedCall.name, argumentValidation.errors),
        });
        debugLog("recovery.invalid_tool_arguments", {
          ...debugContext,
          toolName: requestedCall.name,
          errors: argumentValidation.errors,
          repairRetries,
          totalRecoveries,
        });
        continue;
      }

      return {
        kind: "final",
        text:
          `xtalpi-pi-tools 请求了参数不符合 schema 的工具调用：${requestedCall.name}。\n\n` +
          `参数错误：${argumentValidation.errors.join("; ")}`,
        usage: accumulatedUsage,
        responseModel,
      };
    }

    if (lastCompletedCall && isSameToolCall(lastCompletedCall, requestedCall)) {
      if (repairRetries < debugContext.maxRepairRetries && totalRecoveries < debugContext.maxTotalRecoveries) {
        repairRetries += 1;
        totalRecoveries += 1;
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({ role: "user", content: buildRepeatedToolRepairPrompt(requestedCall.name) });
        debugLog("recovery.repeated_tool", {
          ...debugContext,
          toolName: requestedCall.name,
          repairRetries,
          totalRecoveries,
        });
        continue;
      }

      return {
        kind: "final",
        text:
          `xtalpi-pi-tools 检测到模型在工具结果返回后仍重复请求同一个工具：${requestedCall.name}。\n\n` +
          "为避免重复执行工具或卡住，本轮已停止自动工具调用。请基于上方已有工具结果继续，或把任务拆小后重试。",
        usage: accumulatedUsage,
        responseModel,
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
      usage: accumulatedUsage,
      responseModel,
    };
  }
}

function createOutputMessage(model: Model<Api>): AssistantMessage {
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

function streamXtalpiPiTools(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createLocalAssistantMessageEventStream();

  void (async () => {
    const output = createOutputMessage(model);
    stream.push({ type: "start", partial: output });

    try {
      const result = await runProviderTurn(model, context, options);
      output.usage = toPiUsage(result.usage);
      if (result.responseModel) output.responseModel = result.responseModel;

      if (result.kind === "tool_call") {
        if (result.leadingText) emitTextBlock(stream, output, result.leadingText);
        emitToolCallBlock(stream, output, result.toolCall);
        if (result.trailingText) emitTextBlock(stream, output, result.trailingText);
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else {
        emitTextBlock(stream, output, result.text);
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
      }

      stream.end(output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeErrorMessage(error);
      debugLog("error.provider", {
        provider: PROVIDER_ID,
        model: model.id,
        ...toErrorTelemetry(error),
      });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
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
