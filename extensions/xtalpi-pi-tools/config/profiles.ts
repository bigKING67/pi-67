export type RuntimeProfile = "reliability" | "balanced" | "low-latency";

export type RuntimeEngine = "legacy" | "shadow" | "v2";

export type RuntimePolicyValues = {
  maxTools: number;
  maxToolResultChars: number;
  maxToolHistoryChars: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
  temperature: number;
  requestAttempts: number;
  perAttemptTimeoutMs: number;
  totalRequestDeadlineMs: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterMs: number;
  retryAfterMaxMs: number;
  maxEmptyRecoveries: number;
  maxFormatRecoveries: number;
  maxFinalRecoveries: number;
  maxRepeatedCallRecoveries: number;
  maxRepairRecoveriesTotal: number;
  maxTotalRecoveries: number;
};

export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = "reliability";
export const DEFAULT_RUNTIME_ENGINE: RuntimeEngine = "v2";

export const RUNTIME_PROFILES: Readonly<Record<RuntimeProfile, Readonly<RuntimePolicyValues>>> = {
  reliability: {
    maxTools: 16,
    maxToolResultChars: 20_000,
    maxToolHistoryChars: 60_000,
    maxOutputTokens: 8_192,
    maxResponseBytes: 4 * 1024 * 1024,
    temperature: 0.1,
    requestAttempts: 3,
    perAttemptTimeoutMs: 60_000,
    totalRequestDeadlineMs: 180_000,
    retryDelayMs: 1_000,
    retryMaxDelayMs: 8_000,
    retryJitterMs: 250,
    retryAfterMaxMs: 30_000,
    maxEmptyRecoveries: 2,
    maxFormatRecoveries: 1,
    maxFinalRecoveries: 1,
    maxRepeatedCallRecoveries: 1,
    maxRepairRecoveriesTotal: 2,
    maxTotalRecoveries: 3,
  },
  balanced: {
    maxTools: 12,
    maxToolResultChars: 16_000,
    maxToolHistoryChars: 40_000,
    maxOutputTokens: 6_144,
    maxResponseBytes: 4 * 1024 * 1024,
    temperature: 0.1,
    requestAttempts: 2,
    perAttemptTimeoutMs: 45_000,
    totalRequestDeadlineMs: 90_000,
    retryDelayMs: 750,
    retryMaxDelayMs: 4_000,
    retryJitterMs: 200,
    retryAfterMaxMs: 15_000,
    maxEmptyRecoveries: 1,
    maxFormatRecoveries: 1,
    maxFinalRecoveries: 1,
    maxRepeatedCallRecoveries: 1,
    maxRepairRecoveriesTotal: 2,
    maxTotalRecoveries: 2,
  },
  "low-latency": {
    maxTools: 8,
    maxToolResultChars: 12_000,
    maxToolHistoryChars: 24_000,
    maxOutputTokens: 4_096,
    maxResponseBytes: 4 * 1024 * 1024,
    temperature: 0,
    requestAttempts: 1,
    perAttemptTimeoutMs: 30_000,
    totalRequestDeadlineMs: 30_000,
    retryDelayMs: 0,
    retryMaxDelayMs: 0,
    retryJitterMs: 0,
    retryAfterMaxMs: 0,
    maxEmptyRecoveries: 1,
    maxFormatRecoveries: 1,
    maxFinalRecoveries: 0,
    maxRepeatedCallRecoveries: 0,
    maxRepairRecoveriesTotal: 1,
    maxTotalRecoveries: 1,
  },
};
