import assert from "node:assert/strict";
import test from "node:test";

import {
  canAcceptImmediatePostToolPlainFinal,
  decideFinalGuardPolicy,
  decideVisionInability,
  finalGuardRequiresPlanBlock,
} from "../../../extensions/xtalpi-pi-tools/turn/provider-final-policy.ts";

const PLAN_VIOLATION = {
  ok: false,
  code: "plan_mode_contract_missing",
  reason: "Plan mode is active but the final answer did not contain a <proposed_plan> block",
  latestUserText: "先给解决计划",
};

const VISION_DETECTION = {
  isVisionTask: true,
  hasImagePath: true,
  hasImageIntent: true,
  hasImageContent: false,
  imagePaths: ["/tmp/screenshot.png"],
  reasonCodes: ["prompt_image_path", "vision_bridge_task"],
};

const SUCCESS_OBSERVATION = {
  toolCall: { type: "toolCall", id: "call_read", name: "read", arguments: { path: "package.json" } },
  fingerprint: "sha256:test",
  status: "success",
  resultMessageIndex: 2,
  resultToolName: "read",
  resultContent: '{"name":"pi-extensions"}',
  sameFingerprintExecutionCount: 1,
  toolNameMismatch: false,
};

function postToolPlainFinalInput(overrides = {}) {
  return {
    parseErrorCode: "invalid_json",
    raw: "Package pi-extensions was read successfully.",
    finalPolicy: { kind: "accept" },
    toolLedger: { latestObservation: SUCCESS_OBSERVATION, pendingCallCount: 0 },
    contextMessageCount: 3,
    totalRecoveries: 0,
    ...overrides,
  };
}

test("plain finals are accepted only immediately after one completed successful tool result", () => {
  assert.equal(canAcceptImmediatePostToolPlainFinal(postToolPlainFinalInput()), true);

  const rejected = [
    { parseErrorCode: "raw_protocol_markup" },
    { raw: '{"kind":"final"' },
    { finalPolicy: { kind: "recover" } },
    {
      toolLedger: {
        latestObservation: { ...SUCCESS_OBSERVATION, status: "deterministic_error" },
        pendingCallCount: 0,
      },
    },
    {
      toolLedger: {
        latestObservation: { ...SUCCESS_OBSERVATION, resultMessageIndex: 1 },
        pendingCallCount: 0,
      },
    },
    { toolLedger: { latestObservation: SUCCESS_OBSERVATION, pendingCallCount: 1 } },
    { toolLedger: { latestObservation: undefined, pendingCallCount: 0 } },
    { totalRecoveries: 1 },
  ];

  for (const override of rejected) {
    assert.equal(canAcceptImmediatePostToolPlainFinal(postToolPlainFinalInput(override)), false);
  }
});

test("final policy accepts valid answers and identifies plan-mode violations", () => {
  assert.equal(finalGuardRequiresPlanBlock(PLAN_VIOLATION), true);
  assert.equal(
    finalGuardRequiresPlanBlock({ code: "weak_final", reason: "weak acknowledgement" }),
    false,
  );
  assert.deepEqual(
    decideFinalGuardPolicy({
      guard: { ok: true },
      raw: "done",
      selectedToolNames: ["read"],
      canRecover: true,
    }),
    { kind: "accept" },
  );
});

test("final policy produces one repair prompt while recovery budget remains", () => {
  const decision = decideFinalGuardPolicy({
    guard: PLAN_VIOLATION,
    raw: "I will inspect the parser next.",
    selectedToolNames: ["read"],
    canRecover: true,
  });

  assert.equal(decision.kind, "recover");
  assert.match(decision.prompt, /xtalpi-pi-tools-premature-final-repair/);
  assert.match(decision.prompt, /<proposed_plan>/);
  assert.match(decision.prompt, /"read"/);
});

test("final policy emits a deterministic plan fallback after recovery exhaustion", () => {
  const decision = decideFinalGuardPolicy({
    guard: PLAN_VIOLATION,
    raw: "Still no plan block.",
    selectedToolNames: ["read"],
    canRecover: false,
  });

  assert.equal(decision.kind, "fallback");
  assert.match(decision.text, /Local fallback note/);
  assert.match(decision.text, /<proposed_plan>/);
});

test("final policy rejects non-plan incomplete answers without hiding the reason", () => {
  const decision = decideFinalGuardPolicy({
    guard: {
      ok: false,
      code: "continuation_no_progress",
      reason: "model promised a future action",
      latestUserText: "继续",
    },
    raw: "I will inspect it next.",
    selectedToolNames: ["read"],
    canRecover: false,
  });

  assert.equal(decision.kind, "reject");
  assert.match(decision.text, /model promised a future action/);
  assert.match(decision.text, /I will inspect it next/);
});

test("vision inability policy repairs once and then fails with an actionable local result", () => {
  assert.deepEqual(
    decideVisionInability({
      detection: { ...VISION_DETECTION, isVisionTask: false },
      selectedVisionTool: "vision_read",
      text: "I cannot inspect this image.",
      latestUserText: "分析截图",
      canRecover: true,
    }),
    { kind: "none" },
  );

  const recovery = decideVisionInability({
    detection: VISION_DETECTION,
    selectedVisionTool: "vision_read",
    text: "I cannot inspect this image.",
    latestUserText: "分析截图",
    canRecover: true,
  });
  assert.equal(recovery.kind, "recover");
  assert.equal(recovery.toolName, "vision_read");
  assert.match(recovery.prompt, /"kind":"tool_call"/);
  assert.match(recovery.prompt, /"name":"vision_read"/);

  const exhausted = decideVisionInability({
    detection: VISION_DETECTION,
    selectedVisionTool: "vision_read",
    text: "I cannot inspect this image.",
    latestUserText: "分析截图",
    canRecover: false,
  });
  assert.equal(exhausted.kind, "final");
  assert.match(exhausted.text, /自动修复预算已用尽/);
  assert.match(exhausted.text, /pi-67 doctor/);
});
