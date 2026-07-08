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
  providerHealthImmediateRetry,
  toErrorTelemetry,
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
import { envInt } from "./retry.ts";
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

type RequestRetryConfig = {
  attempts: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterMs: number;
};

const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 1000;
const DEFAULT_REQUEST_RETRY_MAX_DELAY_MS = 8000;
const DEFAULT_REQUEST_RETRY_JITTER_MS = 250;

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

function resolveRequestRetryConfig(): RequestRetryConfig {
  return {
    attempts: Math.min(envInt("XTALPI_PI_TOOLS_REQUEST_ATTEMPTS", DEFAULT_REQUEST_ATTEMPTS, 1), 8),
    retryDelayMs: envInt("XTALPI_PI_TOOLS_RETRY_DELAY_MS", DEFAULT_REQUEST_RETRY_DELAY_MS, 0),
    retryMaxDelayMs: envInt("XTALPI_PI_TOOLS_RETRY_MAX_DELAY_MS", DEFAULT_REQUEST_RETRY_MAX_DELAY_MS, 0),
    retryJitterMs: envInt("XTALPI_PI_TOOLS_RETRY_JITTER_MS", DEFAULT_REQUEST_RETRY_JITTER_MS, 0),
  };
}

function requestRetryDelayMs(config: RequestRetryConfig, failedAttempt: number): number {
  const exponentialDelay = config.retryDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  const boundedDelay = config.retryMaxDelayMs > 0 ? Math.min(exponentialDelay, config.retryMaxDelayMs) : exponentialDelay;
  const jitter = config.retryJitterMs > 0 ? Math.floor(Math.random() * (config.retryJitterMs + 1)) : 0;
  return boundedDelay + jitter;
}

function retrySuppressedReason(error: XtalpiProviderError, attempt: number, attempts: number, signal?: AbortSignal): string | undefined {
  if (signal?.aborted) return "caller_aborted";
  if (attempt >= attempts) return "attempts_exhausted";
  if (!error.retryable) return "non_retryable_error";
  if (!providerHealthImmediateRetry(error.code)) {
    return error.code === "http_429" ? "rate_limit_immediate_retry_disabled" : "provider_immediate_retry_disabled";
  }
  return undefined;
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfCallerAborted(signal);
  if (delayMs <= 0) return;

  let removeAbortListener: (() => void) | undefined;
  const delayPromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    removeAbortListener = () => clearTimeout(timeout);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortHandler = () => reject(buildProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
      cause: abortReason(signal),
    }));
    signal?.addEventListener("abort", abortHandler, { once: true });
    const previousRemove = removeAbortListener;
    removeAbortListener = () => {
      previousRemove?.();
      signal?.removeEventListener("abort", abortHandler);
    };
  });

  try {
    await Promise.race([delayPromise, abortPromise]);
  } finally {
    removeAbortListener?.();
  }
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
  const retryConfig = resolveRequestRetryConfig();
  const endpoint = endpointFor(model, runtimeConfig);
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(model.headers || {}),
      ...(options?.headers || {}),
    },
    body: JSON.stringify(payload),
  };

  for (let attempt = 1; attempt <= retryConfig.attempts; attempt += 1) {
    throwIfCallerAborted(options?.signal);
    debugLog("request", {
      provider: PROVIDER_ID,
      model: model.id,
      messageCount: payload.messages.length,
      maxTokens: payload.max_tokens,
      nativeToolsPresent: false,
      actionProtocol: JSON_ACTION_PROTOCOL,
      responseFormat: jsonActionResponseFormat()?.type ?? null,
      timeoutMs,
      attempt,
      attemptCount: retryConfig.attempts,
      retryCount: attempt - 1,
    });

    try {
      const { response, body } = await fetchTextWithTimeout(
        endpoint,
        init,
        timeoutMs,
        options?.signal,
      );

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
        attempt,
        attemptCount: retryConfig.attempts,
        retryCount: attempt - 1,
      });

      return parsed;
    } catch (error) {
      const providerError =
        error instanceof XtalpiProviderError
          ? error
          : classifyTransportError(error, timeoutMs, options?.signal?.aborted === true);
      const suppressedReason = retrySuppressedReason(providerError, attempt, retryConfig.attempts, options?.signal);
      const telemetry = {
        provider: PROVIDER_ID,
        model: model.id,
        attempt,
        attemptCount: retryConfig.attempts,
        retryCount: Math.max(0, attempt - 1),
        ...toErrorTelemetry(providerError),
      };

      if (!suppressedReason) {
        const retryDelayMs = requestRetryDelayMs(retryConfig, attempt);
        debugLog("request.retry", {
          ...telemetry,
          retryCount: attempt,
          retryDelayMs,
        });
        await sleepWithAbort(retryDelayMs, options?.signal);
        continue;
      }

      debugLog("request.retry_suppressed", {
        ...telemetry,
        retrySuppressedReason: suppressedReason,
      });
      throw providerError;
    }
  }

  throw buildProviderError("unknown_error", "xtalpi-pi-tools request retry loop ended without a result");
}
