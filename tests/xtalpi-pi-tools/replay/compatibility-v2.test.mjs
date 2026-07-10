import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { debugLog, flushDebugLogs } from "../../../extensions/xtalpi-pi-tools/diagnostics.ts";
import { runProviderTurn } from "../../../extensions/xtalpi-pi-tools/provider-turn.ts";
import { serializeContextForXtalpi } from "../../../extensions/xtalpi-pi-tools/serializer.ts";
import { buildToolExecutionLedger } from "../../../extensions/xtalpi-pi-tools/turn/tool-execution-ledger.ts";
import {
  READ_TOOL,
  TEST_MODEL,
  scriptedChat,
  simpleTool,
  withRuntimeEnv,
} from "../test-support.mjs";

const fixtureFile = new URL("../fixtures/tool-ledger-cases.json", import.meta.url);
const ledgerCases = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));

test("ledger replay fixtures preserve pairing, duplicate, and mismatch semantics", () => {
  for (const fixture of ledgerCases) {
    const ledger = buildToolExecutionLedger({ messages: fixture.messages });
    assert.equal(ledger.observations.length, fixture.expect.observations, fixture.name);
    assert.equal(ledger.pendingCallCount, fixture.expect.pendingCallCount, fixture.name);
    assert.equal(ledger.unpairedResultCount, fixture.expect.unpairedResultCount, fixture.name);
    assert.equal(ledger.duplicateResultCount, fixture.expect.duplicateResultCount, fixture.name);
    if (fixture.expect.toolNameMismatch !== undefined) {
      assert.equal(ledger.latestObservation?.toolNameMismatch, fixture.expect.toolNameMismatch, fixture.name);
    }
    if (fixture.expect.status) assert.equal(ledger.latestObservation?.status, fixture.expect.status, fixture.name);
    if (fixture.expect.errorCode) assert.equal(ledger.latestObservation?.errorCode, fixture.expect.errorCode, fixture.name);
  }
});

test("receipt v2 is model-visible without using role=tool", () => {
  const context = {
    systemPrompt: "system base",
    tools: [READ_TOOL],
    messages: [
      { role: "user", content: "Read missing.txt" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "missing.txt" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_read",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "ENOENT: missing.txt" }],
      },
    ],
  };
  const ledger = buildToolExecutionLedger(context);
  const serialized = serializeContextForXtalpi(context, {
    maxTools: 8,
    maxToolResultChars: 2_000,
    maxToolHistoryChars: 4_000,
    toolLedger: ledger,
    useToolResultReceiptV2: true,
  });
  const receiptMessage = serialized.messages.find((message) =>
    message.role === "user" && message.content.includes("xtalpi-pi-tools.tool-result.v2"),
  );
  assert.ok(receiptMessage);
  assert.match(receiptMessage.content, /"status":"deterministic_error"/);
  assert.match(receiptMessage.content, /"error_code":"ENOENT"/);
  assert.match(receiptMessage.content, /"repeat_policy":"same_call_forbidden"/);
  assert.ok(serialized.messages.every((message) => message.role !== "tool"));
  assert.equal(serialized.toolResultReceiptVersion, "v2");
});

test("ENOENT recovery boost never bypasses an explicit only-tool constraint", async () => {
  await withRuntimeEnv({
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_MAX_TOOLS: "1",
    XTALPI_PI_TOOLS_MAX_FORMAT_RECOVERIES: "1",
    XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "1",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "1",
  }, async () => {
    const chat = scriptedChat([
      '{"kind":"tool_call","name":"fffind","arguments":{"query":"missing.txt"}}',
      '{"kind":"final","text":"The explicitly allowed read call failed with ENOENT; no unapproved discovery tool was executed."}',
    ]);
    const result = await runProviderTurn({
      model: TEST_MODEL,
      context: {
        systemPrompt: "system base",
        tools: [READ_TOOL, simpleTool("fffind", { query: { type: "string" } })],
        messages: [
          { role: "user", content: "Only use read for missing.txt. Do not use fffind." },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "missing.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "ENOENT" }],
          },
        ],
      },
      callChat: chat.callChat,
    });
    assert.equal(result.kind, "final");
    assert.equal(chat.calls.length, 2);
    assert.match(chat.calls[0].messages[0].content, /Available Pi tools \(1\/2/);
    assert.match(chat.calls[0].messages[0].content, /- read:/);
    assert.ok(!chat.calls[0].messages[0].content.includes("- fffind:"));
    assert.match(chat.calls[1].messages.at(-1).content, /xtalpi-pi-tools-unknown-tool-repair/);
  });
});

test("shadow engine records legacy and v2 decision divergence", async () => {
  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-shadow-test."));
  const debugFile = path.join(debugDir, "debug.jsonl");
  try {
    await withRuntimeEnv({
      XTALPI_PI_TOOLS_ENGINE: "shadow",
      XTALPI_PI_TOOLS_DEBUG: "1",
      XTALPI_PI_TOOLS_DEBUG_PATH: debugFile,
      XTALPI_PI_TOOLS_MAX_REPEATED_CALL_RECOVERIES: "1",
      XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "1",
      XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "1",
    }, async () => {
      const chat = scriptedChat([
        '{"kind":"tool_call","name":"read","arguments":{"path":"remote.txt"}}',
        '{"kind":"final","text":"Shadow mode retained legacy execution while recording that v2 would allow one transient read retry."}',
      ]);
      const result = await runProviderTurn({
        model: TEST_MODEL,
        context: {
          systemPrompt: "system base",
          tools: [READ_TOOL],
          messages: [
            { role: "user", content: "Read remote.txt" },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "remote.txt" } }],
            },
            {
              role: "toolResult",
              toolCallId: "call_read",
              toolName: "read",
              isError: true,
              content: [{ type: "text", text: "ETIMEDOUT while reading remote.txt" }],
            },
          ],
        },
        callChat: chat.callChat,
      });
      assert.equal(result.kind, "final");
      await flushDebugLogs();
    });

    const events = fs.readFileSync(debugFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const shadow = events.find((event) => event.event === "tool_decision.shadow");
    assert.ok(shadow);
    assert.equal(shadow.data.legacyDecisionKind, "repair");
    assert.equal(shadow.data.v2DecisionKind, "accept");
    assert.equal(shadow.data.decisionsDiffer, true);
    assert.equal(shadow.data.observationStatus, "transient_error");
  } finally {
    debugLog("test.cleanup", {});
    await flushDebugLogs();
    fs.rmSync(debugDir, { recursive: true, force: true });
  }
});
