import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveString } from "./diagnostics.ts";
import { readJsonFile } from "./json-file.ts";
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
  requiredCodes: XtalpiErrorCode[];
  allowedCategories: XtalpiErrorCategory[];
  requiredHttpStatus: Record<string, XtalpiErrorCode>;
  classificationSamples: Record<string, XtalpiErrorCode>;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string" && item.length > 0);
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function contractFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "provider-error-contract.json");
}

function contractHttpStatusCode(contract: ProviderErrorContract, status: number): XtalpiErrorCode {
  const exact = contract.httpStatus[String(status)];
  if (exact) return exact;
  for (const range of contract.httpStatusRanges) {
    if (status >= range.min && status <= range.max) return range.code;
  }
  return "http_error";
}

function loadProviderErrorContract(): ProviderErrorContract {
  const file = contractFilePath();
  const parsed = readJsonFile(file);
  if (!isObject(parsed) || parsed.schema !== "xtalpi-pi-tools.provider-error-contract.v1") {
    throw new Error(`invalid xtalpi provider error contract schema: ${file}`);
  }
  if (
    !isStringArray(parsed.requiredCodes) ||
    !isStringArray(parsed.allowedCategories) ||
    !isStringRecord(parsed.requiredHttpStatus) ||
    !isStringRecord(parsed.classificationSamples) ||
    !isObject(parsed.errors) ||
    !isObject(parsed.httpStatus) ||
    !Array.isArray(parsed.httpStatusRanges)
  ) {
    throw new Error(`invalid xtalpi provider error contract shape: ${file}`);
  }
  const contract = parsed as ProviderErrorContract;
  const actualCodes = Object.keys(contract.errors);
  if (!sameSortedStrings(actualCodes, contract.requiredCodes)) {
    throw new Error(`xtalpi provider error contract codes do not match requiredCodes: ${file}`);
  }
  const allowedCategories = new Set(contract.allowedCategories);
  for (const code of contract.requiredCodes) {
    const metadata = contract.errors[code];
    if (
      !metadata ||
      !allowedCategories.has(metadata.category) ||
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
  for (const [status, code] of Object.entries(contract.requiredHttpStatus)) {
    if (!/^[0-9]+$/.test(status) || contract.httpStatus[status] !== code) {
      throw new Error(`invalid xtalpi provider error requiredHttpStatus mapping ${status}: ${file}`);
    }
  }
  for (const range of contract.httpStatusRanges) {
    if (
      !Number.isInteger(range.min) ||
      !Number.isInteger(range.max) ||
      range.min < 100 ||
      range.max > 599 ||
      range.min > range.max ||
      !contract.errors[range.code]
    ) {
      throw new Error(`invalid xtalpi provider error httpStatus range: ${file}`);
    }
  }
  for (const [status, code] of Object.entries(contract.classificationSamples)) {
    if (!/^[0-9]+$/.test(status) || contractHttpStatusCode(contract, Number(status)) !== code) {
      throw new Error(`invalid xtalpi provider error classification sample ${status}: ${file}`);
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

type ProviderErrorBuildOptions = Omit<ClassifiedErrorOptions, "category" | "retryable">;

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

export function buildProviderError(
  code: XtalpiErrorCode,
  message: string,
  options: ProviderErrorBuildOptions = {},
): XtalpiProviderError {
  const metadata = providerErrorMetadata(code);
  return new XtalpiProviderError(code, message, {
    ...options,
    category: metadata.category,
    retryable: metadata.retryable,
  });
}

function httpStatusCode(status: number): XtalpiErrorCode {
  return contractHttpStatusCode(PROVIDER_ERROR_CONTRACT, status);
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
  return buildProviderError(
    classified.code,
    `xtalpi-pi-tools upstream HTTP ${status} (${classified.category}, retryable=${classified.retryable}): ${bodyExcerpt}`,
    {
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
    return buildProviderError("request_aborted", "xtalpi-pi-tools request aborted by caller", {
      cause: error,
    });
  }

  if (rawMessage.includes("timeout after") || name === "AbortError") {
    return buildProviderError(
      "request_timeout",
      `xtalpi-pi-tools request timeout after ${timeoutMs}ms`,
      {
        details: { timeoutMs },
        cause: error,
      },
    );
  }

  return buildProviderError("network_error", `xtalpi-pi-tools network error: ${rawMessage}`, {
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
