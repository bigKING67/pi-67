import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flushDebugLogs } from "../../../extensions/xtalpi-pi-tools/diagnostics.ts";
import registerXtalpiPiTools from "../../../extensions/xtalpi-pi-tools/index.ts";
import {
  TEST_MODEL,
  chatCompletionBody,
  withFetch,
  withRuntimeEnv,
} from "../test-support.mjs";

const CONTEXT = {
  systemPrompt: "system base",
  tools: [],
  messages: [{ role: "user", content: "hello" }],
};

function registeredProvider() {
  let provider;
  registerXtalpiPiTools({
    registerProvider(id, config) {
      assert.equal(id, "xtalpi-pi-tools");
      provider = config;
    },
  });
  assert.equal(typeof provider?.streamSimple, "function");
  return provider;
}

function readDebugEvents(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

async function withDebugEvents(prefix, env, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const debugFile = path.join(directory, "debug.jsonl");
  try {
    return await withRuntimeEnv({
      XTALPI_PI_TOOLS_API_KEY: "test-key",
      XTALPI_PI_TOOLS_DEBUG: "1",
      XTALPI_PI_TOOLS_DEBUG_PATH: debugFile,
      ...env,
    }, async () => {
      const value = await callback(registeredProvider());
      await flushDebugLogs();
      return { value, events: readDebugEvents(debugFile) };
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("provider stream keeps caller abort distinct and redacts abort reasons", async () => {
  const { value, events } = await withDebugEvents("xtalpi-provider-abort.", {
    XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "1",
  }, async (provider) => {
    let preAbortedFetchCount = 0;
    const preAborted = new AbortController();
    preAborted.abort(new Error("pre-cancelled token=secret_abort_token"));
    const preAbortedFinal = await withFetch(async () => {
      preAbortedFetchCount += 1;
      return new Response(chatCompletionBody("unused"), { status: 200 });
    }, () => provider.streamSimple(TEST_MODEL, CONTEXT, { signal: preAborted.signal }).result());

    let midFlightFetchCount = 0;
    const midFlight = new AbortController();
    const midFlightFinal = await withFetch(async (_input, init) => {
      midFlightFetchCount += 1;
      setTimeout(() => midFlight.abort(new Error("mid-flight cancelled token=secret_midflight_token")), 0);
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")), { once: true });
      });
    }, () => provider.streamSimple(TEST_MODEL, CONTEXT, { signal: midFlight.signal }).result());

    return { preAbortedFetchCount, preAbortedFinal, midFlightFetchCount, midFlightFinal };
  });

  assert.equal(value.preAbortedFetchCount, 0);
  assert.equal(value.preAbortedFinal.stopReason, "aborted");
  assert.match(value.preAbortedFinal.errorMessage, /request aborted by caller/);
  assert.equal(value.midFlightFetchCount, 1);
  assert.equal(value.midFlightFinal.stopReason, "aborted");
  assert.match(value.midFlightFinal.errorMessage, /request aborted by caller/);

  const errors = events.filter((event) => event.event === "error.provider");
  assert.equal(errors.length, 2);
  assert.ok(errors.every((event) => event.error_code === "request_aborted"));
  assert.ok(errors.every((event) => event.error_category === "aborted"));
  assert.ok(!JSON.stringify(errors).includes("secret_abort_token"));
  assert.ok(!JSON.stringify(errors).includes("secret_midflight_token"));
});

test("provider stream reports response body timeouts with retry metadata", async () => {
  const startedAt = Date.now();
  const { value, events } = await withDebugEvents("xtalpi-provider-body-timeout.", {
    XTALPI_PI_TOOLS_TIMEOUT_MS: "1000",
    XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "1",
  }, async (provider) => {
    let fetchCount = 0;
    const final = await withFetch(async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        text: () => new Promise(() => {}),
      };
    }, () => provider.streamSimple(TEST_MODEL, CONTEXT, {}).result());
    return { fetchCount, final };
  });

  assert.equal(value.fetchCount, 1);
  assert.equal(value.final.stopReason, "error");
  assert.match(value.final.errorMessage, /request timeout after 1000ms/);
  assert.ok(Date.now() - startedAt < 5000, "response body timeout exceeded the bounded test window");

  const error = events.find((event) => event.event === "error.provider");
  assert.ok(error);
  assert.equal(error.error_code, "request_timeout");
  assert.equal(error.error_category, "timeout");
  assert.equal(error.retryable, true);
  assert.equal(error.data.timeoutMs, 1000);
});

test("HTTP 429 exhaustion is classified, redacted, and observable", async () => {
  const { value, events } = await withDebugEvents("xtalpi-provider-http429.", {
    XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "3",
    XTALPI_PI_TOOLS_RETRY_DELAY_MS: "0",
    XTALPI_PI_TOOLS_RETRY_JITTER_MS: "0",
  }, async (provider) => {
    let fetchCount = 0;
    const final = await withFetch(async () => {
      fetchCount += 1;
      return new Response("rate limited for Bearer short", {
        status: 429,
        headers: { "content-type": "text/plain" },
      });
    }, () => provider.streamSimple(TEST_MODEL, CONTEXT, {}).result());
    return { fetchCount, final };
  });

  assert.equal(value.fetchCount, 3);
  assert.equal(value.final.stopReason, "error");
  assert.match(value.final.errorMessage, /HTTP 429/);
  assert.ok(!value.final.errorMessage.includes("Bearer short"));
  assert.ok(value.final.errorMessage.includes("Bearer [REDACTED]"));

  const error = events.find((event) => event.event === "error.provider");
  assert.ok(error);
  assert.equal(error.error_code, "http_429");
  assert.equal(error.error_category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.http_status, 429);
  assert.ok(!JSON.stringify(error).includes("Bearer short"));
  assert.ok(JSON.stringify(error).includes("Bearer [REDACTED]"));

  const retry = events.find((event) => event.event === "request.retry");
  assert.equal(retry?.data.retryDelaySource, "retry_after_fallback");
  const suppressed = events.find((event) => event.event === "request.retry_suppressed");
  assert.equal(suppressed?.error_code, "http_429");
  assert.equal(suppressed?.retry_suppressed_reason, "attempts_exhausted");
});

test("HTTP 503 retry succeeds and records the final attempt counters", async () => {
  const { value, events } = await withDebugEvents("xtalpi-provider-http503.", {
    XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "2",
    XTALPI_PI_TOOLS_RETRY_DELAY_MS: "0",
    XTALPI_PI_TOOLS_RETRY_JITTER_MS: "0",
  }, async (provider) => {
    let fetchCount = 0;
    const final = await withFetch(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response("temporary upstream failure", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(chatCompletionBody('{"kind":"final","text":"runtime retry ok"}'), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, () => provider.streamSimple(TEST_MODEL, CONTEXT, {}).result());
    return { fetchCount, final };
  });

  assert.equal(value.fetchCount, 2);
  assert.equal(value.final.stopReason, "stop");
  assert.equal(
    value.final.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
    "runtime retry ok",
  );

  const retry = events.find((event) => event.event === "request.retry");
  assert.equal(retry?.error_code, "http_5xx");
  assert.equal(retry?.retryable, true);
  assert.equal(retry?.retry_delay_ms, 0);
  const response = events.find((event) => event.event === "response");
  assert.equal(response?.attempt, 2);
  assert.equal(response?.attempt_count, 2);
  assert.equal(response?.retry_count, 1);
});
