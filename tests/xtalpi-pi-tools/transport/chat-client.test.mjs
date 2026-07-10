import assert from "node:assert/strict";
import test from "node:test";

import { callXtalpiChat } from "../../../extensions/xtalpi-pi-tools/chat-client.ts";
import { resolveRuntimePolicy } from "../../../extensions/xtalpi-pi-tools/config/runtime-policy.ts";
import {
  TEST_MODEL,
  chatCompletionBody,
  withFetch,
  withRuntimeEnv,
} from "../test-support.mjs";

const MESSAGES = [{ role: "user", content: "hello" }];
const RUNTIME_CONFIG = { apiKey: "test-api-key", baseUrl: "https://example.invalid/v1" };

function policy(overrides = {}) {
  return { ...resolveRuntimePolicy({ env: {} }), ...overrides };
}

async function call(overrides = {}) {
  return callXtalpiChat({
    model: TEST_MODEL,
    messages: MESSAGES,
    runtimeConfig: RUNTIME_CONFIG,
    ...overrides,
  });
}

test("Retry-After seconds is honored with a configured clamp", async () => {
  let fetchCount = 0;
  const started = performance.now();
  await withFetch(async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response(chatCompletionBody('{"kind":"final","text":"ok"}'), { status: 200 });
  }, async () => {
    const result = await call({
      policy: policy({
        requestAttempts: 2,
        perAttemptTimeoutMs: 100,
        totalRequestDeadlineMs: 500,
        retryAfterMaxMs: 5,
        retryDelayMs: 0,
        retryJitterMs: 0,
      }),
    });
    assert.match(result.content, /"ok"/);
  });
  assert.equal(fetchCount, 2);
  assert.ok(performance.now() - started < 400, "Retry-After clamp should prevent a one-second test delay");
});

test("HTTP-date Retry-After is parsed and clamped", async () => {
  let fetchCount = 0;
  const retryDate = new Date(Date.now() + 60_000).toUTCString();
  await withFetch(async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": retryDate } });
    }
    return new Response(chatCompletionBody('{"kind":"final","text":"ok"}'), { status: 200 });
  }, async () => {
    await call({
      policy: policy({
        requestAttempts: 2,
        perAttemptTimeoutMs: 100,
        totalRequestDeadlineMs: 500,
        retryAfterMaxMs: 5,
        retryDelayMs: 0,
        retryJitterMs: 0,
      }),
    });
  });
  assert.equal(fetchCount, 2);
});

test("total request deadline bounds repeated timed-out attempts", async () => {
  let fetchCount = 0;
  const started = performance.now();
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    fetchCount += 1;
    const signal = init.signal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), async () => {
    await assert.rejects(
      () => call({
        policy: policy({
          requestAttempts: 4,
          perAttemptTimeoutMs: 20,
          totalRequestDeadlineMs: 55,
          retryDelayMs: 0,
          retryMaxDelayMs: 0,
          retryJitterMs: 0,
        }),
      }),
      (error) => error.code === "request_deadline_exhausted",
    );
  });
  assert.ok(fetchCount >= 2 && fetchCount <= 4);
  assert.ok(performance.now() - started < 300, "deadline must cap the whole request loop");
});

test("retry is rejected when backoff cannot fit inside the deadline", async () => {
  await withFetch(async () => new Response("temporary", { status: 503 }), async () => {
    await assert.rejects(
      () => call({
        policy: policy({
          requestAttempts: 2,
          perAttemptTimeoutMs: 100,
          totalRequestDeadlineMs: 50,
          retryDelayMs: 80,
          retryMaxDelayMs: 80,
          retryJitterMs: 0,
        }),
      }),
      (error) => error.code === "request_deadline_exhausted" &&
        error.details?.requestedRetryDelayMs === 80,
    );
  });
});

test("Content-Length over the response limit fails before body parsing", async () => {
  let fetchCount = 0;
  await withFetch(async () => {
    fetchCount += 1;
    return new Response("{}", { status: 200, headers: { "content-length": "1024" } });
  }, async () => {
    await assert.rejects(
      () => call({ policy: policy({ requestAttempts: 3, maxResponseBytes: 16 }) }),
      (error) => error.code === "response_too_large" && error.details?.source === "content_length",
    );
  });
  assert.equal(fetchCount, 1);
});

test("streaming response bytes are bounded even without Content-Length", async () => {
  let fetchCount = 0;
  await withFetch(async () => {
    fetchCount += 1;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }, async () => {
    await assert.rejects(
      () => call({ policy: policy({ requestAttempts: 3, maxResponseBytes: 6 }) }),
      (error) => error.code === "response_too_large" && error.details?.source === "stream",
    );
  });
  assert.equal(fetchCount, 1);
});

test("invalid runtime policy maps to configuration_invalid before fetch", async () => {
  let fetchCount = 0;
  await withRuntimeEnv({ XTALPI_PI_TOOLS_ENGINE: "invalid" }, async () => {
    await withFetch(async () => {
      fetchCount += 1;
      return new Response(chatCompletionBody("unused"), { status: 200 });
    }, async () => {
      await assert.rejects(
        () => call(),
        (error) => error.code === "configuration_invalid" &&
          error.details?.configurationVariable === "XTALPI_PI_TOOLS_ENGINE",
      );
    });
  });
  assert.equal(fetchCount, 0);
});

test("caller abort and internal timeout remain distinct", async () => {
  let fetchCount = 0;
  const caller = new AbortController();
  caller.abort(new Error("cancelled by test"));
  await withFetch(async () => {
    fetchCount += 1;
    return new Response(chatCompletionBody("unused"), { status: 200 });
  }, async () => {
    await assert.rejects(
      () => call({ options: { signal: caller.signal }, policy: policy({ requestAttempts: 1 }) }),
      (error) => error.code === "request_aborted",
    );
  });
  assert.equal(fetchCount, 0);

  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    fetchCount += 1;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }), async () => {
    await assert.rejects(
      () => call({
        policy: policy({
          requestAttempts: 1,
          perAttemptTimeoutMs: 20,
          totalRequestDeadlineMs: 100,
        }),
      }),
      (error) => error.code === "request_timeout",
    );
  });
  assert.equal(fetchCount, 1);
});
