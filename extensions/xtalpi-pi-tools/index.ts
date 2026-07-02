import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderModelConfig,
  SimpleStreamOptions,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "./argument-validator.ts";
import { debugLog, safeErrorMessage } from "./diagnostics.ts";
import {
  buildHttpError,
  buildProviderError,
  classifyTransportError,
  toErrorTelemetry,
} from "./errors.ts";
import { parseToolCall } from "./parser.ts";
import {
  API_ID,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_MAX_TOOLS,
  DEFAULT_TIMEOUT_MS,
  EMPTY_USAGE,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROTOCOL_VERSION,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  type UsageSummary,
  type XtalpiChatMessage,
  type XtalpiChatPayload,
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
  maxEmptyRetries,
  maxRepairRetries,
  maxTotalRecoveries,
} from "./retry.ts";
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

type ProviderRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  models: ProviderModelConfig[];
};

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

const DEFAULT_MODELS: ProviderModelConfig[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (Pi local tools)",
    api: API_ID,
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (Pi local tools)",
    api: API_ID,
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "xtalpi-science-flagship",
    name: "晶泰科学旗舰模型 (Pi local tools)",
    api: API_ID,
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "xtalpi-science-standard",
    name: "晶泰科学标准模型 (Pi local tools)",
    api: API_ID,
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlaceholderKey(value: string | undefined): boolean {
  return !value || value.includes("YOUR_") || value.includes("REPLACE_") || value === "changeme";
}

function extensionAgentDir(): string {
  const file = fileURLToPath(import.meta.url);
  return resolve(dirname(file), "../..");
}

function candidateAgentDirs(): string[] {
  const home = process.env.HOME || "";
  return [
    process.env.PI_AGENT_DIR || "",
    home ? join(home, ".pi", "agent") : "",
    extensionAgentDir(),
  ].filter(Boolean);
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readLocalModelsJson(): Record<string, unknown> | undefined {
  for (const dir of candidateAgentDirs()) {
    const file = join(dir, "models.json");
    if (!existsSync(file)) continue;
    const json = readJsonFile(file);
    if (isObject(json)) return json;
  }
  return undefined;
}

function providerFromModels(models: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
  const providers = isObject(models?.providers) ? models.providers : undefined;
  const provider = providers && isObject(providers[id]) ? providers[id] : undefined;
  return provider;
}

function providerModels(provider: Record<string, unknown> | undefined): ProviderModelConfig[] | undefined {
  if (!Array.isArray(provider?.models)) return undefined;
  const models = provider.models.filter(isObject).map((model) => ({
    id: String(model.id || ""),
    name: String(model.name || model.id || ""),
    api: API_ID,
    reasoning: false,
    input: ["text"] as Array<"text">,
    contextWindow: Number(model.contextWindow || 262144),
    maxTokens: Number(model.maxTokens || 32768),
    cost: isObject(model.cost)
      ? {
          input: Number(model.cost.input || 0),
          output: Number(model.cost.output || 0),
          cacheRead: Number(model.cost.cacheRead || 0),
          cacheWrite: Number(model.cost.cacheWrite || 0),
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  return models.length > 0 ? models : undefined;
}

function stringField(provider: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = provider?.[field];
  return typeof value === "string" ? value : undefined;
}

function loadRuntimeConfig(): ProviderRuntimeConfig {
  const models = readLocalModelsJson();
  const primary = providerFromModels(models, PROVIDER_ID);
  const legacyTools = providerFromModels(models, "xtalpi-tools");
  const legacyReasoning = providerFromModels(models, "xtalpi");
  const providers = [primary, legacyTools, legacyReasoning];

  const baseUrl =
    process.env.XTALPI_PI_TOOLS_BASE_URL ||
    process.env.XTALPI_BASE_URL ||
    providers.map((provider) => stringField(provider, "baseUrl")).find(Boolean) ||
    DEFAULT_BASE_URL;
  const apiKey =
    process.env.XTALPI_PI_TOOLS_API_KEY ||
    process.env.XTALPI_API_KEY ||
    providers.map((provider) => stringField(provider, "apiKey")).find((value) => !isPlaceholderKey(value)) ||
    stringField(primary, "apiKey") ||
    "";
  const modelsFromConfig = providerModels(primary);

  return {
    baseUrl,
    apiKey,
    models: modelsFromConfig || DEFAULT_MODELS,
  };
}

function usageFromResponse(value: unknown): UsageSummary {
  if (!isObject(value)) return { ...EMPTY_USAGE };
  const input = Number(value.prompt_tokens ?? value.input_tokens ?? 0);
  const output = Number(value.completion_tokens ?? value.output_tokens ?? 0);
  const cacheRead = Number(value.prompt_cache_hit_tokens ?? value.cache_read_tokens ?? 0);
  const cacheWrite = Number(value.prompt_cache_miss_tokens ?? value.cache_write_tokens ?? 0);
  const totalTokens = Number(value.total_tokens ?? input + output + cacheRead + cacheWrite);
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function toPiUsage(usage: UsageSummary): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function endpointFor(model: Model<Api>): string {
  const baseUrl = normalizeBaseUrl(model.baseUrl || runtimeConfig?.baseUrl || DEFAULT_BASE_URL);
  return `${baseUrl}/chat/completions`;
}

export function resolveRequestTimeoutMs(options?: Pick<SimpleStreamOptions, "timeoutMs">): number {
  const optionTimeoutMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1000
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  return envInt("XTALPI_PI_TOOLS_TIMEOUT_MS", optionTimeoutMs, 1000);
}

export function resolveMaxOutputTokens(
  model: Pick<Model<Api>, "maxTokens">,
  options?: Pick<SimpleStreamOptions, "maxTokens">,
): number {
  const optionMaxTokens =
    typeof options?.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens >= 1
      ? Math.floor(options.maxTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const configuredMax = envInt("XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS", optionMaxTokens, 1);
  return Math.min(configuredMax, model.maxTokens || 32768);
}

export function buildChatCompletionPayload(
  model: Pick<Model<Api>, "id" | "maxTokens">,
  messages: XtalpiChatMessage[],
  options?: Pick<SimpleStreamOptions, "temperature" | "maxTokens">,
): XtalpiChatPayload {
  const maxTokens = resolveMaxOutputTokens(model, options);
  const payload: XtalpiChatPayload = {
    model: model.id,
    messages,
    stream: false,
    max_tokens: maxTokens,
  };

  if (typeof options?.temperature === "number") {
    payload.temperature = options.temperature;
  }

  return payload;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`xtalpi-pi-tools timeout after ${timeoutMs}ms`)), timeoutMs);
  const abortHandler = () => controller.abort(signal?.reason || new Error("aborted"));
  if (signal) signal.addEventListener("abort", abortHandler, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortHandler);
  }
}

function extractTextFromMessage(message: unknown): string {
  if (!isObject(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isObject(block) && typeof block.text === "string") return block.text;
        return "";
      })
      .join("");
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) {
    const first = toolCalls.find(isObject);
    const fn = isObject(first?.function) ? first.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    const rawArgs = typeof fn?.arguments === "string" ? fn.arguments : "{}";
    let args: unknown = {};
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = {};
    }
    if (name) {
      return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name, arguments: isObject(args) ? args : {} })}\n${TOOL_CALL_CLOSE}`;
    }
  }

  return "";
}

async function callXtalpiChat(
  model: Model<Api>,
  messages: XtalpiChatMessage[],
  options?: SimpleStreamOptions,
): Promise<ChatResponse> {
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
  try {
    response = await fetchWithTimeout(
      endpointFor(model),
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
    );
  } catch (error) {
    throw classifyTransportError(error, timeoutMs, options?.signal?.aborted === true);
  }

  const body = await response.text();
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

function hashSelectedToolNames(names: string[]): string {
  return createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);
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
  const selectedToolNames = [...names].sort();
  const selectedToolByName = new Map(serializedContext.selectedTools.map((tool) => [tool.name, tool]));
  const messages = serializedContext.messages;
  const lastCompletedCall = latestToolCallWithResult(contextLike);
  const debugContext = {
    provider: PROVIDER_ID,
    model: model.id,
    protocolVersion: PROTOCOL_VERSION,
    selectedToolCount: serializedContext.selectedTools.length,
    selectedToolNames,
    selectedToolNamesHash: hashSelectedToolNames(selectedToolNames),
    availableToolCount: contextLike.tools?.length ?? 0,
    maxTools,
    toolSelectionClipped: serializedContext.toolSelectionSummary.clipped,
    toolSelectionOmittedCount: serializedContext.toolSelectionSummary.omittedToolCount,
    toolSelectionValidCount: serializedContext.toolSelectionSummary.validToolCount,
    toolSelectionSummary: serializedContext.toolSelectionSummary,
    maxToolResultChars,
    maxOutputTokens: resolveMaxOutputTokens(model, options),
    requestTimeoutMs: resolveRequestTimeoutMs(options),
    maxEmptyRetries: maxEmptyRetries(),
    maxRepairRetries: maxRepairRetries(),
    maxTotalRecoveries: maxTotalRecoveries(),
  };
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
      if (emptyRetries < maxEmptyRetries() && totalRecoveries < maxTotalRecoveries()) {
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
      if (repairRetries < maxRepairRetries() && totalRecoveries < maxTotalRecoveries()) {
        repairRetries += 1;
        totalRecoveries += 1;
        const repairPrompt = parsed.code === "function_style_tool_call"
          ? buildFunctionStyleToolRepairPrompt(parsed.raw, [...names].sort())
          : parsed.code === "raw_protocol_markup"
            ? buildRawProtocolMarkupRepairPrompt(parsed.raw, [...names].sort())
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
      if (repairRetries < maxRepairRetries() && totalRecoveries < maxTotalRecoveries()) {
        repairRetries += 1;
        totalRecoveries += 1;
        messages.push({ role: "assistant", content: raw.slice(0, 4000) });
        messages.push({ role: "user", content: buildUnknownToolRepairPrompt(requestedCall.name, [...names].sort()) });
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
        text: `xtalpi-pi-tools 请求了不可用工具：${requestedCall.name}。本轮可用工具：${[...names].sort().join(", ") || "(none)"}`,
        usage: accumulatedUsage,
        responseModel,
      };
    }

    const argumentValidation = validateToolArguments(selectedToolByName.get(requestedCall.name), requestedCall.arguments);
    if (!argumentValidation.ok) {
      if (repairRetries < maxRepairRetries() && totalRecoveries < maxTotalRecoveries()) {
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
      if (repairRetries < maxRepairRetries() && totalRecoveries < maxTotalRecoveries()) {
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
