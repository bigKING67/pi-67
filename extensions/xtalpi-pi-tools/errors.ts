import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  | "config_error"
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

type ProviderErrorMetadata = {
  category: XtalpiErrorCategory;
  retryable: boolean;
  healthImmediateRetry: boolean;
};

type ProviderErrorContract = {
  schema: string;
  errors: Record<string, ProviderErrorMetadata>;
  httpStatus: Record<string, XtalpiErrorCode>;
  httpStatusRanges: Array<{
    min: number;
    max: number;
    code: XtalpiErrorCode;
  }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "provider-error-contract.json");
}

function loadProviderErrorContract(): ProviderErrorContract {
  const file = contractFilePath();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isObject(parsed) || parsed.schema !== "xtalpi-pi-tools.provider-error-contract.v1") {
    throw new Error(`invalid xtalpi provider error contract schema: ${file}`);
  }
  if (!isObject(parsed.errors) || !isObject(parsed.httpStatus) || !Array.isArray(parsed.httpStatusRanges)) {
    throw new Error(`invalid xtalpi provider error contract shape: ${file}`);
  }
  const contract = parsed as ProviderErrorContract;
  for (const code of [
    "api_key_missing",
    "config_error",
    "http_401",
    "http_403",
    "http_408",
    "http_429",
    "http_5xx",
    "http_error",
    "malformed_response",
    "network_error",
    "non_json_response",
    "request_aborted",
    "request_timeout",
    "unknown_error",
  ]) {
    const metadata = contract.errors[code];
    if (
      !metadata ||
      typeof metadata.category !== "string" ||
      typeof metadata.retryable !== "boolean" ||
      typeof metadata.healthImmediateRetry !== "boolean"
    ) {
      throw new Error(`invalid xtalpi provider error metadata for ${code}: ${file}`);
    }
  }
  for (const [status, code] of Object.entries(contract.httpStatus)) {
    if (!/^[0-9]+$/.test(status) || !contract.errors[code]) {
      throw new Error(`invalid xtalpi provider error httpStatus mapping ${status}: ${file}`);
    }
  }
  for (const range of contract.httpStatusRanges) {
    if (
      !Number.isInteger(range.min) ||
      !Number.isInteger(range.max) ||
      range.min > range.max ||
      !contract.errors[range.code]
    ) {
      throw new Error(`invalid xtalpi provider error httpStatus range: ${file}`);
    }
  }
  return contract;
}

const PROVIDER_ERROR_CONTRACT = loadProviderErrorContract();

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

export function providerErrorMetadata(code: XtalpiErrorCode): ProviderErrorMetadata {
  return PROVIDER_ERROR_CONTRACT.errors[code] || PROVIDER_ERROR_CONTRACT.errors.unknown_error;
}

export function providerHealthImmediateRetry(code: XtalpiErrorCode): boolean {
  return providerErrorMetadata(code).healthImmediateRetry === true;
}

function httpStatusCode(status: number): XtalpiErrorCode {
  const exact = PROVIDER_ERROR_CONTRACT.httpStatus[String(status)];
  if (exact) return exact;
  for (const range of PROVIDER_ERROR_CONTRACT.httpStatusRanges) {
    if (status >= range.min && status <= range.max) return range.code;
  }
  return "http_error";
}

export function classifyHttpStatus(status: number): Pick<ClassifiedErrorOptions, "category" | "retryable"> & {
  code: XtalpiErrorCode;
} {
  const code = httpStatusCode(status);
  const metadata = providerErrorMetadata(code);
  return { code, category: metadata.category, retryable: metadata.retryable };
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
    const metadata = providerErrorMetadata("request_aborted");
    return new XtalpiProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
      category: metadata.category,
      retryable: metadata.retryable,
      cause: error,
    });
  }

  if (rawMessage.includes("timeout after") || name === "AbortError") {
    const metadata = providerErrorMetadata("request_timeout");
    return new XtalpiProviderError(
      "request_timeout",
      `xtalpi-pi-tools request timeout after ${timeoutMs}ms`,
      {
        category: metadata.category,
        retryable: metadata.retryable,
        details: { timeoutMs },
        cause: error,
      },
    );
  }

  const metadata = providerErrorMetadata("network_error");
  return new XtalpiProviderError("network_error", `xtalpi-pi-tools network error: ${rawMessage}`, {
    category: metadata.category,
    retryable: metadata.retryable,
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
  const metadata = providerErrorMetadata("unknown_error");
  return {
    errorCode: "unknown_error",
    errorCategory: metadata.category,
    retryable: metadata.retryable,
    errorMessage: redactSensitiveString(message),
  };
}
