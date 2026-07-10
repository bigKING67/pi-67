import assert from "node:assert/strict";
import test from "node:test";

import { runProviderTurn } from "../../../extensions/xtalpi-pi-tools/provider-turn.ts";
import { decideToolCallRequest } from "../../../extensions/xtalpi-pi-tools/tool-call-decision.ts";
import { TurnLoopState } from "../../../extensions/xtalpi-pi-tools/turn-loop-state.ts";
import {
  READ_TOOL,
  TEST_MODEL,
  scriptedChat,
  simpleTool,
  withRuntimeEnv,
} from "../test-support.mjs";

function observation(name, status, sameFingerprintExecutionCount = 1, errorCode) {
  return {
    toolCall: { type: "toolCall", id: `call_${name}`, name, arguments: name === "read" ? { path: "missing.txt" } : {} },
    fingerprint: `sha256:${"a".repeat(64)}`,
    status,
    ...(errorCode ? { errorCode } : {}),
    resultMessageIndex: 2,
    resultContent: errorCode ?? status,
    sameFingerprintExecutionCount,
    toolNameMismatch: false,
  };
}

function decideFor(observationValue, options = {}) {
  const tool = observationValue.toolCall.name === "read"
    ? READ_TOOL
    : simpleTool(observationValue.toolCall.name);
  return decideToolCallRequest({
    requestedCall: {
      name: observationValue.toolCall.name,
      arguments: observationValue.toolCall.arguments,
    },
    selectedToolNames: new Set([tool.name]),
    selectedToolNamesList: [tool.name],
    selectedToolByName: new Map([[tool.name, tool]]),
    lastObservation: observationValue,
    canRepair: options.canRepair ?? true,
    canRecoverRepeated: options.canRecoverRepeated ?? true,
    discoveryToolNames: ["fffind", "find"],
  });
}

test("ENOENT repeated read is repaired once and ends with a non-empty final", async () => {
  await withRuntimeEnv({
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_MAX_FORMAT_RECOVERIES: "1",
    XTALPI_PI_TOOLS_MAX_REPEATED_CALL_RECOVERIES: "1",
    XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "2",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "2",
  }, async () => {
    const chat = scriptedChat([
      '{"kind":"tool_call","name":"read","arguments":{"path":"missing.txt"}}',
      '{"kind":"final","text":"The requested path is missing (ENOENT). No duplicate read was executed; inspect the parent directory with fffind or find."}',
    ]);
    const result = await runProviderTurn({
      model: TEST_MODEL,
      context: {
        systemPrompt: "system base",
        tools: [
          READ_TOOL,
          simpleTool("fffind", { query: { type: "string" } }),
          simpleTool("find", { path: { type: "string" } }),
          simpleTool("ls", { path: { type: "string" } }),
          simpleTool("ffgrep", { query: { type: "string" } }),
          simpleTool("grep", { query: { type: "string" } }),
        ],
        messages: [
          { role: "user", content: "Read missing.txt and report the result." },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "missing.txt" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read",
            isError: true,
            content: [{ type: "text", text: "ENOENT: no such file or directory, open 'missing.txt'" }],
          },
        ],
      },
      callChat: chat.callChat,
    });

    assert.equal(result.kind, "final");
    assert.ok(result.text.trim().length > 0);
    assert.equal(chat.calls.length, 2);
    const repairPrompt = chat.calls[1].messages.at(-1).content;
    assert.match(repairPrompt, /xtalpi-pi-tools-repeated-tool-repair/);
    assert.match(repairPrompt, /ENOENT/);
    assert.match(repairPrompt, /"fffind"/);
    assert.match(repairPrompt, /"find"/);
    assert.match(repairPrompt, /Do not repeat the same tool name with the same arguments/);
  });
});

test("successful and deterministic results never repeat", () => {
  const success = decideFor(observation("read", "success"));
  assert.equal(success.kind, "repair");
  assert.equal(success.event, "recovery.repeated_tool");

  const deterministic = decideFor(observation("read", "deterministic_error", 1, "ENOENT"));
  assert.equal(deterministic.kind, "repair");
  assert.match(deterministic.prompt, /different discovery tool/);
});

test("transient read retries once but not twice", () => {
  const firstRetry = decideFor(observation("read", "transient_error", 1, "ETIMEDOUT"));
  assert.equal(firstRetry.kind, "accept");
  assert.equal(firstRetry.repeatPolicyDecision?.policy, "same_call_allowed_once_after_transient_error");

  const secondRetry = decideFor(observation("read", "transient_error", 2, "ETIMEDOUT"));
  assert.equal(secondRetry.kind, "repair");
  assert.equal(secondRetry.event, "recovery.repeated_tool");
});

test("side-effecting, cancelled, and unknown outcomes never auto-repeat", () => {
  for (const name of ["bash", "edit", "write"]) {
    const decision = decideFor(observation(name, "transient_error", 1, "ETIMEDOUT"));
    assert.equal(decision.kind, "repair", name);
  }
  assert.equal(decideFor(observation("read", "cancelled", 1, "CANCELLED")).kind, "repair");
  assert.equal(decideFor(observation("read", "unknown_error")).kind, "repair");
});

test("repeated-call recovery has an independent one-shot budget", () => {
  const state = new TurnLoopState();
  const budget = {
    maxRepairRetries: 2,
    maxTotalRecoveries: 3,
    maxRepeatedCallRecoveries: 1,
  };
  assert.equal(state.canRecoverRepeatedCall(budget), true);
  const counters = state.noteRepeatedCallRecovery();
  assert.equal(counters.repeatedCallRecoveries, 1);
  assert.equal(counters.repairRetries, 1);
  assert.equal(counters.totalRecoveries, 1);
  assert.equal(state.canRecoverRepeatedCall(budget), false);
  assert.equal(state.canRecoverFormat({ ...budget, maxFormatRecoveries: 1 }), true);
});
