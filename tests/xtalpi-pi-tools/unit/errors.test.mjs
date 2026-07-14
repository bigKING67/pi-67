import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildProviderError,
  classifyHttpStatus,
  classifyTransportError,
  providerHealthImmediateRetry,
  toErrorTelemetry,
  validateProviderErrorContract,
} from "../../../extensions/xtalpi-pi-tools/errors.ts";

const PROVIDER_ERROR_CONTRACT = JSON.parse(fs.readFileSync(
  new URL("../../../extensions/xtalpi-pi-tools/provider-error-contract.json", import.meta.url),
  "utf8",
));

function contractCopy() {
  return structuredClone(PROVIDER_ERROR_CONTRACT);
}

test("provider errors redact nested details and protect canonical telemetry fields", () => {
  const error = buildProviderError(
    "network_error",
    "network failed with Bearer visible-secret",
    {
      status: 503,
      details: {
        bodyExcerpt: "token=detail-secret",
        nested: { password: "nested-secret" },
        errorCode: "forged_code",
        retryable: false,
      },
    },
  );

  assert.ok(!error.message.includes("visible-secret"));
  assert.ok(!JSON.stringify(error.details).includes("detail-secret"));
  assert.ok(!JSON.stringify(error.details).includes("nested-secret"));

  error.details.bodyExcerpt = "password=late-mutation-secret";
  const telemetry = toErrorTelemetry(error);
  assert.ok(!JSON.stringify(telemetry).includes("late-mutation-secret"));
  assert.equal(telemetry.errorCode, "network_error");
  assert.equal(telemetry.errorCategory, "network");
  assert.equal(telemetry.retryable, true);
  assert.equal(telemetry.httpStatus, 503);
});

test("transport classification uses explicit abort ownership instead of AbortError names", () => {
  const upstreamAbort = new Error("upstream stream aborted");
  upstreamAbort.name = "AbortError";

  assert.equal(classifyTransportError(upstreamAbort, {
    timeoutMs: 1_000,
    callerAborted: false,
    timedOut: false,
  }).code, "network_error");
  assert.equal(classifyTransportError(upstreamAbort, {
    timeoutMs: 1_000,
    callerAborted: false,
    timedOut: true,
  }).code, "request_timeout");
  assert.equal(classifyTransportError(upstreamAbort, {
    timeoutMs: 1_000,
    callerAborted: true,
    timedOut: false,
  }).code, "request_aborted");
});

test("error metadata fallback and unknown telemetry remain deterministic and redacted", () => {
  assert.equal(classifyHttpStatus(418).code, "http_error");
  assert.equal(classifyHttpStatus(200).code, "http_error");
  assert.equal(providerHealthImmediateRetry("request_timeout"), true);

  const telemetry = toErrorTelemetry(new Error("unknown token=unknown-secret"));
  assert.equal(telemetry.errorCode, "unknown_error");
  assert.equal(telemetry.errorCategory, "upstream");
  assert.equal(telemetry.retryable, false);
  assert.ok(!telemetry.errorMessage.includes("unknown-secret"));
});

test("provider error contract validation is pure and covers every structural boundary", () => {
  assert.doesNotThrow(() => validateProviderErrorContract(contractCopy(), "valid-test-contract"));

  const cases = [
    ["schema", (contract) => { contract.schema = "invalid"; }, /contract schema: schema/],
    ["shape", (contract) => { contract.errors = []; }, /contract shape: shape/],
    ["codes", (contract) => { contract.requiredCodes.pop(); }, /codes do not match requiredCodes: codes/],
    ["metadata", (contract) => { contract.errors.http_429.retryable = "yes"; }, /metadata for http_429: metadata/],
    ["http-status", (contract) => { contract.httpStatus.invalid = "http_error"; }, /httpStatus mapping invalid: http-status/],
    ["required-status", (contract) => { contract.requiredHttpStatus["401"] = "http_403"; }, /requiredHttpStatus mapping 401: required-status/],
    ["range", (contract) => { contract.httpStatusRanges = [null]; }, /httpStatus range: range/],
    ["range-fields", (contract) => { contract.httpStatusRanges[0].min = 99; }, /httpStatus range: range-fields/],
    ["sample", (contract) => { contract.classificationSamples["503"] = "http_error"; }, /classification sample 503: sample/],
  ];

  for (const [source, mutate, expected] of cases) {
    const contract = contractCopy();
    mutate(contract);
    assert.throws(() => validateProviderErrorContract(contract, source), expected);
  }
});
