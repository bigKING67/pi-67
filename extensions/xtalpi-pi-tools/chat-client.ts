import type {
  Api,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { debugLog } from "./diagnostics.ts";
import {
  XtalpiProviderError,
  buildHttpError,
  buildProviderError,
  classifyTransportError,
} from "./errors.ts";
import {
  PROVIDER_ID,
  type UsageSummary,
  type XtalpiChatMessage,
} from "./protocol.ts";
import {
  JSON_ACTION_PROTOCOL,
  jsonActionResponseFormat,
} from "./json-action-protocol.ts";
import {
  extractTextFromMessage,
  usageFromResponse,
} from "./response-normalizer.ts";
import {
  buildChatCompletionPayload,
  endpointFor,
  isPlaceholderKey,
  resolveRequestTimeoutMs,
  type ProviderRuntimeConfig,
} from "./runtime-config.ts";
import { safeBlockText } from "./text-safety.ts";

export type XtalpiChatResponse = {
  content: string;
  usage: UsageSummary;
  responseModel?: string;
  finishReason?: string;
};

type FetchTextResult = {
  response: Response;
  body: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason || new Error("aborted");
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw buildProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
    cause: abortReason(signal),
  });
}

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

export function parseXtalpiChatResponse(body: string): XtalpiChatResponse {
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

  return {
    content: extractTextFromMessage(message),
    usage: usageFromResponse(root.usage),
    responseModel: typeof root.model === "string" ? root.model : undefined,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : undefined,
  };
}

export async function callXtalpiChat(input: {
  model: Model<Api>;
  messages: XtalpiChatMessage[];
  options?: SimpleStreamOptions;
  runtimeConfig?: Pick<ProviderRuntimeConfig, "apiKey" | "baseUrl">;
}): Promise<XtalpiChatResponse> {
  const { model, messages, options, runtimeConfig } = input;
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
    actionProtocol: JSON_ACTION_PROTOCOL,
    responseFormat: jsonActionResponseFormat()?.type ?? null,
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

  const parsed = parseXtalpiChatResponse(body);
  debugLog("response", {
    provider: PROVIDER_ID,
    model: model.id,
    responseModel: parsed.responseModel,
    finishReason: parsed.finishReason,
    contentChars: parsed.content.length,
    usage: parsed.usage,
  });

  return parsed;
}
