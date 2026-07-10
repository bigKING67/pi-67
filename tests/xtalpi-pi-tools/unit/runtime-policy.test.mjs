import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimePolicyConfigurationError,
  resolveRuntimePolicy,
} from "../../../extensions/xtalpi-pi-tools/config/runtime-policy.ts";

test("reliability v2 is the deterministic default", () => {
  const policy = resolveRuntimePolicy({ env: {} });
  assert.equal(policy.profile, "reliability");
  assert.equal(policy.engine, "v2");
  assert.equal(policy.maxTools, 16);
  assert.equal(policy.maxToolResultChars, 20_000);
  assert.equal(policy.maxToolHistoryChars, 60_000);
  assert.equal(policy.perAttemptTimeoutMs, 60_000);
  assert.equal(policy.totalRequestDeadlineMs, 180_000);
  assert.equal(policy.sources.profile, "default");
  assert.equal(policy.sources.engine, "default");
});

test("direct env overrides legacy env and request options", () => {
  const policy = resolveRuntimePolicy({
    env: {
      XTALPI_PI_TOOLS_PROFILE: "balanced",
      XTALPI_PI_TOOLS_ENGINE: "shadow",
      XTALPI_PI_TOOLS_PER_ATTEMPT_TIMEOUT_MS: "12000",
      XTALPI_PI_TOOLS_TIMEOUT_MS: "13000",
      XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS: "4096",
      XTALPI_PI_TOOLS_TEMPERATURE: "0.25",
    },
    options: { timeoutMs: 14_000, maxTokens: 5_000, temperature: 0.5 },
  });
  assert.equal(policy.profile, "balanced");
  assert.equal(policy.engine, "shadow");
  assert.equal(policy.perAttemptTimeoutMs, 12_000);
  assert.equal(policy.maxOutputTokens, 4_096);
  assert.equal(policy.temperature, 0.25);
  assert.equal(policy.sources.perAttemptTimeoutMs, "XTALPI_PI_TOOLS_PER_ATTEMPT_TIMEOUT_MS");
});

test("legacy env names remain compatible", () => {
  const policy = resolveRuntimePolicy({
    env: {
      XTALPI_PI_TOOLS_TIMEOUT_MS: "15000",
      XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES: "3",
      XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "4",
    },
  });
  assert.equal(policy.perAttemptTimeoutMs, 15_000);
  assert.equal(policy.maxEmptyRecoveries, 3);
  assert.equal(policy.maxRepairRecoveriesTotal, 4);
  assert.equal(policy.sources.perAttemptTimeoutMs, "XTALPI_PI_TOOLS_TIMEOUT_MS");
  assert.equal(policy.sources.maxEmptyRecoveries, "XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES");
  assert.equal(policy.sources.maxRepairRecoveriesTotal, "XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES");
});

test("request options are used when env is absent", () => {
  const policy = resolveRuntimePolicy({
    env: {},
    options: { timeoutMs: 12_345, maxTokens: 2_048, temperature: 0.4 },
  });
  assert.equal(policy.perAttemptTimeoutMs, 12_345);
  assert.equal(policy.maxOutputTokens, 2_048);
  assert.equal(policy.temperature, 0.4);
  assert.equal(policy.sources.maxOutputTokens, "request_option");
});

test("invalid enums and numbers fail fast with the offending variable", () => {
  assert.throws(
    () => resolveRuntimePolicy({ env: { XTALPI_PI_TOOLS_ENGINE: "future" } }),
    (error) => error instanceof RuntimePolicyConfigurationError &&
      error.code === "configuration_invalid" &&
      error.variable === "XTALPI_PI_TOOLS_ENGINE",
  );
  assert.throws(
    () => resolveRuntimePolicy({ env: { XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "0" } }),
    (error) => error instanceof RuntimePolicyConfigurationError &&
      error.variable === "XTALPI_PI_TOOLS_REQUEST_ATTEMPTS",
  );
});

test("result and history budgets preserve the containment invariant", () => {
  assert.throws(
    () => resolveRuntimePolicy({
      env: {
        XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS: "2000",
        XTALPI_PI_TOOLS_MAX_TOOL_HISTORY_CHARS: "1000",
      },
    }),
    (error) => error instanceof RuntimePolicyConfigurationError &&
      error.variable === "XTALPI_PI_TOOLS_MAX_TOOL_HISTORY_CHARS",
  );
});
