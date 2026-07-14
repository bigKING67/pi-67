import assert from "node:assert/strict";
import test from "node:test";

import { providerErrorMetadata } from "../../../extensions/xtalpi-pi-tools/errors.ts";
import { validateFinalAnswer } from "../../../extensions/xtalpi-pi-tools/final-guard.ts";
import { decodeJsonText } from "../../../extensions/xtalpi-pi-tools/json-file.ts";
import { jsonDeepEqual } from "../../../extensions/xtalpi-pi-tools/json-utils.ts";
import { serializeContextForXtalpi } from "../../../extensions/xtalpi-pi-tools/serializer.ts";
import { buildToolExecutionLedger } from "../../../extensions/xtalpi-pi-tools/turn/tool-execution-ledger.ts";
import { visionTaskPromptText } from "../../../extensions/xtalpi-pi-tools/vision-bridge.ts";
import { READ_TOOL } from "../test-support.mjs";

test("UTF-16BE JSON decoding swaps only complete byte pairs", () => {
  const encoded = Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
  assert.equal(decodeJsonText(encoded), "{}");
});

test("canonical deep equality handles reordered and mismatched indexed values", () => {
  assert.equal(jsonDeepEqual(
    { b: 2, a: { y: 4, x: 3 } },
    { a: { x: 3, y: 4 }, b: 2 },
  ), true);
  assert.equal(jsonDeepEqual([{ b: 2, a: 1 }], [{ a: 1, b: 2 }]), true);
  assert.equal(jsonDeepEqual([{ b: 2, a: 1 }], [{ b: 2 }, { a: 1 }]), false);
});

test("sparse message histories are skipped consistently across provider boundaries", () => {
  const messages = new Array(6);
  messages[1] = { role: "user", content: "old request" };
  messages[3] = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "package.json" } }],
  };
  messages[4] = {
    role: "toolResult",
    toolCallId: "call_read",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: '{"name":"pi-extensions"}' }],
  };
  messages[5] = { role: "user", content: "read package.json" };

  const ledger = buildToolExecutionLedger({ messages });
  assert.equal(ledger.observations.length, 1);
  assert.equal(ledger.latestObservation?.status, "success");

  const serialized = serializeContextForXtalpi({
    systemPrompt: "system base",
    tools: [READ_TOOL],
    messages,
  }, {
    maxTools: 8,
    maxToolResultChars: 2_000,
    maxToolHistoryChars: 4_000,
    toolLedger: ledger,
    useToolResultReceiptV2: true,
  });
  assert.equal(serialized.toolSelectionPromptText, "read package.json");
  assert.ok(serialized.messages.some((message) => message.content.includes("pi-extensions")));

  assert.deepEqual(validateFinalAnswer({
    text: "The package metadata was read successfully.",
    context: { systemPrompt: "system base", tools: [READ_TOOL], messages },
    selectedToolNames: ["read"],
  }), { ok: true });
  assert.equal(visionTaskPromptText(messages), "read package.json");
});

test("unknown provider error codes resolve through the mandatory fallback metadata", () => {
  assert.deepEqual(providerErrorMetadata("future_provider_error"), {
    category: "upstream",
    retryable: false,
    healthImmediateRetry: false,
    runtimeRetryPolicy: "never",
  });
});
