import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  DEFAULT_RUNTIME_ENGINE,
  DEFAULT_RUNTIME_PROFILE,
  RUNTIME_PROFILES,
  type RuntimeEngine,
  type RuntimePolicyValues,
  type RuntimeProfile,
} from "./profiles.ts";

export type RuntimePolicy = RuntimePolicyValues & {
  profile: RuntimeProfile;
  engine: RuntimeEngine;
  sources: Readonly<Record<keyof RuntimePolicyValues | "profile" | "engine", string>>;
};

export type RuntimePolicyInput = {
  options?: Pick<SimpleStreamOptions, "timeoutMs" | "maxTokens" | "temperature">;
  env?: Record<string, string | undefined>;
};

export class RuntimePolicyConfigurationError extends Error {
  readonly code = "configuration_invalid";
  readonly variable: string | undefined;

  constructor(message: string, variable?: string) {
    super(message);
    this.name = "RuntimePolicyConfigurationError";
    this.variable = variable;
  }
}

type NumericSpec = {
  env: string;
  legacyEnv?: string | undefined;
  min: number;
  max: number;
  integer?: boolean;
  optionValue?: number | undefined;
};

const POLICY_LIMITS: Record<keyof RuntimePolicyValues, { min: number; max: number; integer?: boolean }> = {
  maxTools: { min: 0, max: 128, integer: true },
  maxToolResultChars: { min: 0, max: 200_000, integer: true },
  maxToolHistoryChars: { min: 0, max: 1_000_000, integer: true },
  maxOutputTokens: { min: 1, max: 131_072, integer: true },
  maxResponseBytes: { min: 1_024, max: 64 * 1024 * 1024, integer: true },
  temperature: { min: 0, max: 2 },
  requestAttempts: { min: 1, max: 8, integer: true },
  perAttemptTimeoutMs: { min: 1_000, max: 600_000, integer: true },
  totalRequestDeadlineMs: { min: 1_000, max: 900_000, integer: true },
  retryDelayMs: { min: 0, max: 120_000, integer: true },
  retryMaxDelayMs: { min: 0, max: 120_000, integer: true },
  retryJitterMs: { min: 0, max: 30_000, integer: true },
  retryAfterMaxMs: { min: 0, max: 120_000, integer: true },
  maxEmptyRecoveries: { min: 0, max: 8, integer: true },
  maxFormatRecoveries: { min: 0, max: 8, integer: true },
  maxFinalRecoveries: { min: 0, max: 8, integer: true },
  maxRepeatedCallRecoveries: { min: 0, max: 8, integer: true },
  maxRepairRecoveriesTotal: { min: 0, max: 16, integer: true },
  maxTotalRecoveries: { min: 0, max: 16, integer: true },
};

const PROFILE_NAMES = new Set<RuntimeProfile>(Object.keys(RUNTIME_PROFILES) as RuntimeProfile[]);
const ENGINE_NAMES = new Set<RuntimeEngine>(["legacy", "shadow", "v2"]);

function enumValue<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  allowed: ReadonlySet<T>,
  fallback: T,
): { value: T; source: string } {
  const raw = env[name]?.trim();
  if (!raw) return { value: fallback, source: "default" };
  if (!allowed.has(raw as T)) {
    throw new RuntimePolicyConfigurationError(
      `${name} must be one of: ${[...allowed].join(", ")}`,
      name,
    );
  }
  return { value: raw as T, source: name };
}

function parseNumeric(name: string, raw: string, spec: NumericSpec): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || (spec.integer && !Number.isInteger(value)) || value < spec.min || value > spec.max) {
    const numericKind = spec.integer ? "integer" : "number";
    throw new RuntimePolicyConfigurationError(
      `${name} must be a ${numericKind} between ${spec.min} and ${spec.max}`,
      name,
    );
  }
  return value;
}

function numericValue(
  env: Record<string, string | undefined>,
  fallback: number,
  spec: NumericSpec,
): { value: number; source: string } {
  const direct = env[spec.env]?.trim();
  if (direct) return { value: parseNumeric(spec.env, direct, spec), source: spec.env };
  const legacy = spec.legacyEnv ? env[spec.legacyEnv]?.trim() : undefined;
  if (legacy) return { value: parseNumeric(spec.legacyEnv!, legacy, spec), source: spec.legacyEnv! };
  if (spec.optionValue !== undefined) {
    return { value: parseNumeric("request option", String(spec.optionValue), spec), source: "request_option" };
  }
  return { value: fallback, source: "profile" };
}

export function resolveRuntimePolicy(input: RuntimePolicyInput = {}): RuntimePolicy {
  const env = input.env ?? process.env;
  const profileResult = enumValue(env, "XTALPI_PI_TOOLS_PROFILE", PROFILE_NAMES, DEFAULT_RUNTIME_PROFILE);
  const engineResult = enumValue(env, "XTALPI_PI_TOOLS_ENGINE", ENGINE_NAMES, DEFAULT_RUNTIME_ENGINE);
  const defaults = RUNTIME_PROFILES[profileResult.value];
  const sources = {} as Record<keyof RuntimePolicyValues | "profile" | "engine", string>;
  sources.profile = profileResult.source;
  sources.engine = engineResult.source;

  const resolve = (
    key: keyof RuntimePolicyValues,
    envName: string,
    options: { legacyEnv?: string | undefined; optionValue?: number | undefined } = {},
  ): number => {
    const limit = POLICY_LIMITS[key];
    const result = numericValue(env, defaults[key], {
      env: envName,
      legacyEnv: options.legacyEnv,
      optionValue: options.optionValue,
      ...limit,
    });
    sources[key] = result.source;
    return result.value;
  };

  const legacyRepairEnv = env.XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES?.trim();
  const maxRepairRecoveriesTotal = legacyRepairEnv && !env.XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL?.trim()
    ? numericValue(env, defaults.maxRepairRecoveriesTotal, {
      env: "XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL",
      legacyEnv: "XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES",
      ...POLICY_LIMITS.maxRepairRecoveriesTotal,
    })
    : numericValue(env, defaults.maxRepairRecoveriesTotal, {
      env: "XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL",
      ...POLICY_LIMITS.maxRepairRecoveriesTotal,
    });
  sources.maxRepairRecoveriesTotal = maxRepairRecoveriesTotal.source;

  const policy: RuntimePolicy = {
    profile: profileResult.value,
    engine: engineResult.value,
    maxTools: resolve("maxTools", "XTALPI_PI_TOOLS_MAX_TOOLS"),
    maxToolResultChars: resolve("maxToolResultChars", "XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS"),
    maxToolHistoryChars: resolve("maxToolHistoryChars", "XTALPI_PI_TOOLS_MAX_TOOL_HISTORY_CHARS"),
    maxOutputTokens: resolve("maxOutputTokens", "XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS", {
      optionValue: input.options?.maxTokens,
    }),
    maxResponseBytes: resolve("maxResponseBytes", "XTALPI_PI_TOOLS_MAX_RESPONSE_BYTES"),
    temperature: resolve("temperature", "XTALPI_PI_TOOLS_TEMPERATURE", {
      optionValue: input.options?.temperature,
    }),
    requestAttempts: resolve("requestAttempts", "XTALPI_PI_TOOLS_REQUEST_ATTEMPTS"),
    perAttemptTimeoutMs: resolve("perAttemptTimeoutMs", "XTALPI_PI_TOOLS_PER_ATTEMPT_TIMEOUT_MS", {
      legacyEnv: "XTALPI_PI_TOOLS_TIMEOUT_MS",
      optionValue: input.options?.timeoutMs,
    }),
    totalRequestDeadlineMs: resolve("totalRequestDeadlineMs", "XTALPI_PI_TOOLS_TOTAL_DEADLINE_MS"),
    retryDelayMs: resolve("retryDelayMs", "XTALPI_PI_TOOLS_RETRY_DELAY_MS"),
    retryMaxDelayMs: resolve("retryMaxDelayMs", "XTALPI_PI_TOOLS_RETRY_MAX_DELAY_MS"),
    retryJitterMs: resolve("retryJitterMs", "XTALPI_PI_TOOLS_RETRY_JITTER_MS"),
    retryAfterMaxMs: resolve("retryAfterMaxMs", "XTALPI_PI_TOOLS_RETRY_AFTER_MAX_MS"),
    maxEmptyRecoveries: resolve("maxEmptyRecoveries", "XTALPI_PI_TOOLS_MAX_EMPTY_RECOVERIES", {
      legacyEnv: "XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES",
    }),
    maxFormatRecoveries: resolve("maxFormatRecoveries", "XTALPI_PI_TOOLS_MAX_FORMAT_RECOVERIES"),
    maxFinalRecoveries: resolve("maxFinalRecoveries", "XTALPI_PI_TOOLS_MAX_FINAL_RECOVERIES"),
    maxRepeatedCallRecoveries: resolve(
      "maxRepeatedCallRecoveries",
      "XTALPI_PI_TOOLS_MAX_REPEATED_CALL_RECOVERIES",
    ),
    maxRepairRecoveriesTotal: maxRepairRecoveriesTotal.value,
    maxTotalRecoveries: resolve("maxTotalRecoveries", "XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES"),
    sources,
  };

  if (policy.retryMaxDelayMs > 0 && policy.retryDelayMs > policy.retryMaxDelayMs) {
    throw new RuntimePolicyConfigurationError(
      "XTALPI_PI_TOOLS_RETRY_DELAY_MS must not exceed XTALPI_PI_TOOLS_RETRY_MAX_DELAY_MS",
      "XTALPI_PI_TOOLS_RETRY_DELAY_MS",
    );
  }
  if (policy.maxToolHistoryChars < policy.maxToolResultChars) {
    throw new RuntimePolicyConfigurationError(
      "XTALPI_PI_TOOLS_MAX_TOOL_HISTORY_CHARS must be >= XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS",
      "XTALPI_PI_TOOLS_MAX_TOOL_HISTORY_CHARS",
    );
  }

  return policy;
}
