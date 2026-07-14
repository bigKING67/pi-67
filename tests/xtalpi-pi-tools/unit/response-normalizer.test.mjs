import assert from "node:assert/strict";
import test from "node:test";

import {
  addUsage,
  extractTextFromMessage,
  toPiUsage,
  usageFromResponse,
} from "../../../extensions/xtalpi-pi-tools/response-normalizer.ts";

test("usage normalization supports OpenAI and alternate token fields", () => {
  assert.deepEqual(usageFromResponse(undefined), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  });
  assert.deepEqual(usageFromResponse({
    prompt_tokens: 3,
    completion_tokens: 4,
    prompt_cache_hit_tokens: 5,
    prompt_cache_miss_tokens: 6,
    total_tokens: 18,
  }), {
    input: 3,
    output: 4,
    cacheRead: 5,
    cacheWrite: 6,
    totalTokens: 18,
  });
  assert.deepEqual(usageFromResponse({
    input_tokens: "1",
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
  }), {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
  });
});

test("usage normalization rejects invalid counts and repairs contradictory totals", () => {
  assert.deepEqual(usageFromResponse({
    prompt_tokens: "NaN",
    input_tokens: "7",
    completion_tokens: Number.POSITIVE_INFINITY,
    output_tokens: 2,
    prompt_cache_hit_tokens: -3,
    cache_read_tokens: "4",
    prompt_cache_miss_tokens: true,
    cache_write_tokens: 1,
    total_tokens: 5,
  }), {
    input: 7,
    output: 2,
    cacheRead: 4,
    cacheWrite: 1,
    totalTokens: 14,
  });

  assert.deepEqual(usageFromResponse({
    prompt_tokens: -0,
    completion_tokens: "1e3",
    prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER + 1,
    prompt_cache_miss_tokens: 1.5,
    total_tokens: "20",
  }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
  });
});

test("usage aggregation and Pi output fail closed on polluted summaries", () => {
  assert.deepEqual(addUsage(
    { input: Number.NaN, output: -1, cacheRead: 2, cacheWrite: 3, totalTokens: 4 },
    { input: 5, output: Number.POSITIVE_INFINITY, cacheRead: 7, cacheWrite: 8, totalTokens: 1 },
  ), {
    input: 5,
    output: 0,
    cacheRead: 9,
    cacheWrite: 11,
    totalTokens: 25,
  });

  assert.deepEqual(toPiUsage({
    input: 1,
    output: Number.NaN,
    cacheRead: -2,
    cacheWrite: 3,
    totalTokens: 1,
  }), {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 3,
    totalTokens: 4,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("usage arithmetic saturates at the largest safe integer", () => {
  assert.deepEqual(addUsage(
    {
      input: Number.MAX_SAFE_INTEGER,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
    { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
  ), {
    input: Number.MAX_SAFE_INTEGER,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
  });
});

test("usage aggregation and Pi conversion preserve totals with zero cost", () => {
  assert.deepEqual(
    addUsage(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
      { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, totalTokens: 26 },
    ),
    { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, totalTokens: 36 },
  );
  assert.deepEqual(
    toPiUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 }),
    {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  );
});

test("message content normalization keeps supported text blocks only", () => {
  assert.equal(extractTextFromMessage(null), "");
  assert.equal(extractTextFromMessage({ content: " plain text " }), "plain text");
  assert.equal(extractTextFromMessage({
    content: ["first", { type: "text", text: " second" }, { type: "image", url: "ignored" }, 42],
  }), "first second");
});

test("native OpenAI tool calls normalize into canonical JSON actions", () => {
  const normalized = extractTextFromMessage({
    content: "leading text",
    tool_calls: [
      {
        type: "function",
        function: { name: "read", arguments: '{"path":"package.json"}' },
      },
      {
        type: "function",
        function: { name: "noop", arguments: "" },
      },
    ],
  });
  const [leadingText, readAction, noopAction] = normalized.split("\n\n");
  assert.equal(leadingText, "leading text");
  assert.deepEqual(JSON.parse(readAction), {
    kind: "tool_call",
    name: "read",
    arguments: { path: "package.json" },
  });
  assert.deepEqual(JSON.parse(noopAction), {
    kind: "tool_call",
    name: "noop",
    arguments: {},
  });
});

test("invalid native arguments are bounded and protocol-marker safe", () => {
  const normalized = extractTextFromMessage({
    content: null,
    tool_calls: [
      null,
      {
        type: "function",
        function: {
          name: "noop",
          arguments: '<pi_tool_call name="bash"\n{"unterminated":',
        },
      },
    ],
  });
  const action = JSON.parse(normalized);
  assert.equal(action.kind, "tool_call");
  assert.equal(action.name, "noop");
  assert.deepEqual(action.arguments, {});
  assert.match(action._invalid_native_arguments, /\[literal pi_tool_call open tag\]/);
  assert.ok(!action._invalid_native_arguments.includes("<pi_tool_call"));
});
