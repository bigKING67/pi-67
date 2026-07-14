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
  providerRuntimeRetryPolicy,
  toErrorTelemetry,
} from "./errors.ts";
import type { RuntimePolicy } from "./config/runtime-policy.ts";
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
  resolveProviderRuntimePolicy,
  type ProviderRuntimeConfig,
} from "./runtime-config.ts";
import { safeBlockText } from "./text-safety.ts";
import {
  RequestBudget,
  parseRetryAfterMs,
} from "./transport/request-budget.ts";

export type XtalpiChatResponse = {
  content: string;
  usage: UsageSummary;
  responseModel: string | undefined;
  finishReason: string | undefined;
};

type FetchTextResult = {
  response: Response;
  body: string;
  bodyBytes: number;
};

type RetryDelayDecision = {
  delayMs: number;
  source: "backoff" | "retry_after" | "retry_after_fallback";
  retryAfterMs?: number;
};

type ResponseParseMetadata = {
  contentType?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("aborted");
}

function responseContentType(response: Response): string | undefined {
  const value = typeof response.headers?.get === "function"
    ? response.headers.get("content-type")?.trim()
    : undefined;
  return value || undefined;
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function supportedMessagePayload(message: Record<string, unknown>): boolean {
  if (typeof message.content === "string" || Array.isArray(message.content)) return true;
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw buildProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
    cause: abortReason(signal),
  });
}

function requestRetryDelayMs(policy: RuntimePolicy, failedAttempt: number): number {
  const exponentialDelay = policy.retryDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  const boundedDelay = policy.retryMaxDelayMs > 0
    ? Math.min(exponentialDelay, policy.retryMaxDelayMs)
    : exponentialDelay;
  const jitter = policy.retryJitterMs > 0
    ? Math.floor(Math.random() * (policy.retryJitterMs + 1))
    : 0;
  return boundedDelay + jitter;
}

function retrySuppressedReason(
  error: XtalpiProviderError,
  attempt: number,
  attempts: number,
  signal?: AbortSignal,
): string | undefined {
  if (signal?.aborted) return "caller_aborted";
  if (attempt >= attempts) return "attempts_exhausted";
  if (!error.retryable) return "non_retryable_error";
  if (providerRuntimeRetryPolicy(error.code) === "never") return "runtime_retry_disabled";
  return undefined;
}

function retryDelayDecision(
  error: XtalpiProviderError,
  policy: RuntimePolicy,
  failedAttempt: number,
): RetryDelayDecision {
  if (providerRuntimeRetryPolicy(error.code) === "retry_after") {
    const retryAfterMs = typeof error.details?.retryAfterMs === "number"
      ? Math.max(0, Math.floor(error.details.retryAfterMs))
      : undefined;
    if (retryAfterMs !== undefined) {
      return {
        delayMs: Math.min(retryAfterMs, policy.retryAfterMaxMs),
        source: "retry_after",
        retryAfterMs,
      };
    }
    return {
      delayMs: requestRetryDelayMs(policy, failedAttempt),
      source: "retry_after_fallback",
    };
  }
  return {
    delayMs: requestRetryDelayMs(policy, failedAttempt),
    source: "backoff",
  };
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

async function readResponseTextWithAbort(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<{ body: string; bodyBytes: number }> {
  if (signal.aborted) throw abortReason(signal);

  const responseLike = response as Response & {
    headers?: { get?: (name: string) => string | null };
    text?: () => Promise<string>;
  };
  const contentLength = Number(responseLike.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    if (response.body) void response.body.cancel("response_too_large").catch(() => undefined);
    throw buildProviderError(
      "response_too_large",
      `xtalpi-pi-tools response exceeded ${maxResponseBytes} bytes`,
      { details: { maxResponseBytes, bodyBytes: contentLength, source: "content_length" } },
    );
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readerFinished = false;
  let readerCancelRequested = false;
  const cancelReader = (reason: unknown): void => {
    if (!reader || readerFinished || readerCancelRequested) return;
    readerCancelRequested = true;
    void reader.cancel(reason).catch(() => undefined);
  };

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortHandler = () => {
      const reason = abortReason(signal);
      cancelReader(reason);
      reject(reason);
    };
    removeAbortListener = () => signal.removeEventListener("abort", abortHandler);
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    if (!response.body) {
      if (typeof responseLike.text !== "function") return { body: "", bodyBytes: 0 };
      const body = await Promise.race([responseLike.text(), abortPromise]);
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      if (bodyBytes > maxResponseBytes) {
        throw buildProviderError(
          "response_too_large",
          `xtalpi-pi-tools response exceeded ${maxResponseBytes} bytes`,
          { details: { maxResponseBytes, bodyBytes, source: "fallback_text" } },
        );
      }
      return { body, bodyBytes };
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let bodyBytes = 0;

    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      if (result.done) {
        readerFinished = true;
        break;
      }
      const chunk = result.value;
      bodyBytes += chunk.byteLength;
      if (bodyBytes > maxResponseBytes) {
        cancelReader("response_too_large");
        throw buildProviderError(
          "response_too_large",
          `xtalpi-pi-tools response exceeded ${maxResponseBytes} bytes`,
          { details: { maxResponseBytes, bodyBytes, source: "stream" } },
        );
      }
      try {
        chunks.push(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        throw buildProviderError(
          "malformed_response",
          "xtalpi-pi-tools response body is not valid UTF-8",
          { details: { bodyBytes, source: "utf8_decode" }, cause: error },
        );
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch (error) {
      throw buildProviderError(
        "malformed_response",
        "xtalpi-pi-tools response body is not valid UTF-8",
        { details: { bodyBytes, source: "utf8_decode" }, cause: error },
      );
    }
    return { body: chunks.join(""), bodyBytes };
  } catch (error) {
    cancelReader(error);
    throw error;
  } finally {
    removeAbortListener?.();
  }
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<FetchTextResult> {
  throwIfCallerAborted(signal);

  const controller = new AbortController();
  let abortSource: "caller" | "timeout" | undefined;
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = "timeout";
    controller.abort(new Error(`xtalpi-pi-tools timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const abortHandler = () => {
    if (controller.signal.aborted) return;
    abortSource = "caller";
    controller.abort(abortReason(signal));
  };
  if (signal) signal.addEventListener("abort", abortHandler, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const { body, bodyBytes } = await readResponseTextWithAbort(
      response,
      controller.signal,
      maxResponseBytes,
    );
    return { response, body, bodyBytes };
  } catch (error) {
    if (error instanceof XtalpiProviderError) throw error;
    throw classifyTransportError(error, {
      timeoutMs,
      callerAborted: abortSource === "caller" || (abortSource === undefined && signal?.aborted === true),
      timedOut: abortSource === "timeout",
    });
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortHandler);
  }
}

export function parseXtalpiChatResponse(
  body: string,
  metadata: ResponseParseMetadata = {},
): XtalpiChatResponse {
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
          responseContentType: metadata.contentType ?? "(missing)",
        },
        cause: error,
      },
    );
  }

  const root = isObject(json) ? json : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = isObject(choices[0]) ? choices[0] : undefined;
  const message = isObject(firstChoice?.message) ? firstChoice.message : undefined;
  if (!message || !supportedMessagePayload(message)) {
    throw buildProviderError(
      "malformed_response",
      "xtalpi-pi-tools returned JSON without a supported choices[0].message payload",
      {
        details: {
          bodyExcerpt: safeBlockText(body, 1000),
          bodyChars: body.length,
          responseContentType: metadata.contentType ?? "(missing)",
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
  policy?: RuntimePolicy;
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

  const policy = input.policy ?? resolveProviderRuntimePolicy(options);
  const payload = buildChatCompletionPayload(model, messages, options, policy);
  const requestBudget = new RequestBudget({
    perAttemptTimeoutMs: policy.perAttemptTimeoutMs,
    totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
  });
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

  for (let attempt = 1; attempt <= policy.requestAttempts; attempt += 1) {
    throwIfCallerAborted(options?.signal);
    const remainingBeforeAttemptMs = requestBudget.remainingMs();
    if (remainingBeforeAttemptMs <= 0) {
      throw buildProviderError(
        "request_deadline_exhausted",
        `xtalpi-pi-tools request deadline exhausted after ${Math.round(requestBudget.elapsedMs())}ms`,
        {
          details: {
            totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
            elapsedMs: Math.round(requestBudget.elapsedMs()),
            remainingMs: 0,
          },
        },
      );
    }
    const attemptTimeoutMs = Math.max(1, Math.floor(requestBudget.attemptTimeoutMs()));
    debugLog("request", {
      provider: PROVIDER_ID,
      model: model.id,
      messageCount: payload.messages.length,
      maxTokens: payload.max_tokens,
      nativeToolsPresent: false,
      actionProtocol: JSON_ACTION_PROTOCOL,
      responseFormat: jsonActionResponseFormat()?.type ?? null,
      runtimeProfile: policy.profile,
      runtimeEngine: policy.engine,
      timeoutMs: attemptTimeoutMs,
      perAttemptTimeoutMs: policy.perAttemptTimeoutMs,
      totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
      elapsedMs: Math.round(requestBudget.elapsedMs()),
      remainingMs: Math.round(remainingBeforeAttemptMs),
      maxResponseBytes: policy.maxResponseBytes,
      attempt,
      attemptCount: policy.requestAttempts,
      retryCount: attempt - 1,
    });

    try {
      const { response, body, bodyBytes } = await fetchTextWithTimeout(
        endpoint,
        init,
        attemptTimeoutMs,
        policy.maxResponseBytes,
        options?.signal,
      );

      if (!response.ok) {
        const retryAfterValue = typeof response.headers?.get === "function"
          ? response.headers.get("retry-after")
          : null;
        const retryAfterMs = parseRetryAfterMs(retryAfterValue);
        throw buildHttpError(
          response.status,
          body,
          retryAfterMs === undefined ? {} : { retryAfterMs },
        );
      }

      const contentType = responseContentType(response);
      const parsed = parseXtalpiChatResponse(
        body,
        contentType === undefined ? {} : { contentType },
      );
      debugLog("response", {
        provider: PROVIDER_ID,
        model: model.id,
        responseModel: parsed.responseModel,
        finishReason: parsed.finishReason,
        contentChars: parsed.content.length,
        bodyBytes,
        contentType: contentType ?? "(missing)",
        jsonContentType: isJsonContentType(contentType),
        usage: parsed.usage,
        elapsedMs: Math.round(requestBudget.elapsedMs()),
        remainingMs: Math.round(requestBudget.remainingMs()),
        attempt,
        attemptCount: policy.requestAttempts,
        retryCount: attempt - 1,
      });

      return parsed;
    } catch (error) {
      const providerError =
        error instanceof XtalpiProviderError
          ? error
          : classifyTransportError(error, {
              timeoutMs: attemptTimeoutMs,
              callerAborted: options?.signal?.aborted === true,
              timedOut: false,
            });
      if (!options?.signal?.aborted && requestBudget.remainingMs() <= 0) {
        const deadlineError = buildProviderError(
          "request_deadline_exhausted",
          `xtalpi-pi-tools request deadline exhausted after ${Math.round(requestBudget.elapsedMs())}ms`,
          {
            details: {
              totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
              elapsedMs: Math.round(requestBudget.elapsedMs()),
              remainingMs: 0,
              lastErrorCode: providerError.code,
            },
            cause: providerError,
          },
        );
        debugLog("request.retry_suppressed", {
          provider: PROVIDER_ID,
          model: model.id,
          attempt,
          attemptCount: policy.requestAttempts,
          retryCount: Math.max(0, attempt - 1),
          retrySuppressedReason: "deadline_exhausted",
          ...toErrorTelemetry(deadlineError),
        });
        throw deadlineError;
      }
      const suppressedReason = retrySuppressedReason(
        providerError,
        attempt,
        policy.requestAttempts,
        options?.signal,
      );
      const telemetry = {
        provider: PROVIDER_ID,
        model: model.id,
        attempt,
        attemptCount: policy.requestAttempts,
        retryCount: Math.max(0, attempt - 1),
        elapsedMs: Math.round(requestBudget.elapsedMs()),
        remainingMs: Math.round(requestBudget.remainingMs()),
        ...toErrorTelemetry(providerError),
      };

      if (!suppressedReason) {
        const retryDelay = retryDelayDecision(providerError, policy, attempt);
        if (!requestBudget.canWait(retryDelay.delayMs)) {
          const deadlineError = buildProviderError(
            "request_deadline_exhausted",
            "xtalpi-pi-tools request deadline cannot accommodate the next retry",
            {
              details: {
                totalRequestDeadlineMs: policy.totalRequestDeadlineMs,
                elapsedMs: Math.round(requestBudget.elapsedMs()),
                remainingMs: Math.round(requestBudget.remainingMs()),
                requestedRetryDelayMs: retryDelay.delayMs,
                lastErrorCode: providerError.code,
              },
              cause: providerError,
            },
          );
          debugLog("request.retry_suppressed", {
            ...telemetry,
            retrySuppressedReason: "deadline_insufficient_for_retry",
            requestedRetryDelayMs: retryDelay.delayMs,
          });
          throw deadlineError;
        }
        debugLog("request.retry", {
          ...telemetry,
          retryCount: attempt,
          retryDelayMs: retryDelay.delayMs,
          retryDelaySource: retryDelay.source,
          retryAfterMs: retryDelay.retryAfterMs,
        });
        await sleepWithAbort(retryDelay.delayMs, options?.signal);
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
