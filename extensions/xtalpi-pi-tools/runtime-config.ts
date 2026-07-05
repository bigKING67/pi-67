import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Api,
  Model,
  ProviderModelConfig,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  API_ID,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER_ID,
  type XtalpiChatMessage,
  type XtalpiChatPayload,
} from "./protocol.ts";
import { readJsonFile as readCompatibleJsonFile } from "./json-file.ts";
import { envInt } from "./retry.ts";

export type ProviderRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  models: ProviderModelConfig[];
};

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

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlaceholderKey(value: string | undefined): boolean {
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
    return readCompatibleJsonFile(file);
  } catch {
    return undefined;
  }
}

function readLocalModelsJson(): Record<string, unknown> | undefined {
  for (const dir of candidateAgentDirs()) {
    const file = join(dir, "models.json");
    if (!existsSync(file)) continue;
    const json = readJsonFile(file);
    if (isConfigObject(json)) return json;
  }
  return undefined;
}

function providerFromModels(models: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
  const providers = isConfigObject(models?.providers) ? models.providers : undefined;
  const provider = providers && isConfigObject(providers[id]) ? providers[id] : undefined;
  return provider;
}

function providerModels(provider: Record<string, unknown> | undefined): ProviderModelConfig[] | undefined {
  if (!Array.isArray(provider?.models)) return undefined;
  const models = provider.models.filter(isConfigObject).map((model) => ({
    id: String(model.id || ""),
    name: String(model.name || model.id || ""),
    api: API_ID,
    reasoning: false,
    input: ["text"] as Array<"text">,
    contextWindow: Number(model.contextWindow || 262144),
    maxTokens: Number(model.maxTokens || 32768),
    cost: isConfigObject(model.cost)
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

export function loadRuntimeConfig(): ProviderRuntimeConfig {
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

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function endpointFor(model: Pick<Model<Api>, "baseUrl">, runtimeConfig?: Pick<ProviderRuntimeConfig, "baseUrl">): string {
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
