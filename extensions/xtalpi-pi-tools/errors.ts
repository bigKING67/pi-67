import { redactSensitiveString } from "./diagnostics.ts";
import { safeBlockText } from "./text-safety.ts";

export type XtalpiErrorCategory =
  | "aborted"
  | "authentication"
  | "configuration"
  | "network"
  | "protocol"
  | "rate_limit"
  | "timeout"
  | "upstream";

export type XtalpiErrorCode =
  | "api_key_missing"
  | "http_401"
  | "http_403"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "http_error"
  | "malformed_response"
  | "network_error"
  | "non_json_response"
  | "request_aborted"
  | "request_timeout"
  | "unknown_error";

export type ClassifiedErrorOptions = {
  category: XtalpiErrorCategory;
  retryable: boolean;
  status?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class XtalpiProviderError extends Error {
  readonly code: XtalpiErrorCode;
  readonly category: XtalpiErrorCategory;
  readonly retryable: boolean;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: XtalpiErrorCode, message: string, options: ClassifiedErrorOptions) {
    super(redactSensitiveString(message));
    this.name = "XtalpiProviderError";
    this.code = code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.status = options.status;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function classifyHttpStatus(status: number): Pick<ClassifiedErrorOptions, "category" | "retryable"> & {
  code: XtalpiErrorCode;
} {
  if (status === 401) return { code: "http_401", category: "authentication", retryable: false };
  if (status === 403) return { code: "http_403", category: "authentication", retryable: false };
  if (status === 408) return { code: "http_408", category: "timeout", retryable: true };
  if (status === 429) return { code: "http_429", category: "rate_limit", retryable: true };
  if (status >= 500) return { code: "http_5xx", category: "upstream", retryable: true };
  return { code: "http_error", category: "upstream", retryable: false };
}

export function buildHttpError(status: number, body: string): XtalpiProviderError {
  const classified = classifyHttpStatus(status);
  const bodyExcerpt = safeBlockText(body || "(no body)", 1000);
  return new XtalpiProviderError(
    classified.code,
    `xtalpi-pi-tools upstream HTTP ${status} (${classified.category}, retryable=${classified.retryable}): ${bodyExcerpt}`,
    {
      category: classified.category,
      retryable: classified.retryable,
      status,
      details: {
        bodyExcerpt,
        bodyChars: body.length,
      },
    },
  );
}

export function classifyTransportError(error: unknown, timeoutMs: number, aborted: boolean): XtalpiProviderError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (aborted) {
    return new XtalpiProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
      category: "aborted",
      retryable: false,
      cause: error,
    });
  }

  if (rawMessage.includes("timeout after") || name === "AbortError") {
    return new XtalpiProviderError(
      "request_timeout",
      `xtalpi-pi-tools request timeout after ${timeoutMs}ms`,
      {
        category: "timeout",
        retryable: true,
        details: { timeoutMs },
        cause: error,
      },
    );
  }

  return new XtalpiProviderError("network_error", `xtalpi-pi-tools network error: ${rawMessage}`, {
    category: "network",
    retryable: true,
    cause: error,
  });
}

export function toErrorTelemetry(error: unknown): Record<string, unknown> {
  if (error instanceof XtalpiProviderError) {
    return {
      errorCode: error.code,
      errorCategory: error.category,
      retryable: error.retryable,
      httpStatus: error.status,
      errorMessage: error.message,
      ...(error.details || {}),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    errorCode: "unknown_error",
    errorCategory: "upstream",
    retryable: false,
    errorMessage: redactSensitiveString(message),
  };
}
