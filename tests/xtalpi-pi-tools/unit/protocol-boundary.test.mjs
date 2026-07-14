import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  containsToolCallLikeFinal,
  detectToolCallLikeFinal,
} from "../../../extensions/xtalpi-pi-tools/protocol-boundary.ts";

const require = createRequire(import.meta.url);
const smokeBoundary = require("../../../scripts/pi67-xtalpi-protocol-boundary-core.cjs");

function summary(finding) {
  return finding.ok
    ? { ok: true }
    : {
        ok: false,
        code: finding.code,
        matchedShape: finding.matchedShape,
        matchedToolName: finding.matchedToolName,
      };
}

function detectWithParity(input) {
  const runtime = detectToolCallLikeFinal(input);
  const smoke = smokeBoundary.detectToolCallLikeFinal(input);
  assert.deepEqual(summary(runtime), summary(smoke));
  return runtime;
}

function expectFinding(input, expected) {
  const finding = detectWithParity(input);
  assert.equal(finding.ok, false);
  assert.equal(finding.code, expected.code);
  assert.equal(finding.matchedShape, expected.matchedShape);
  assert.equal(finding.matchedToolName, expected.name);
  assert.match(finding.reason, /exactly one canonical local action object/);
}

function sampleArguments(name) {
  if (name === "bash") return { command: "pwd" };
  if (name === "web_fetch") return { url: "https://example.invalid/" };
  if (name === "mcp") return {};
  if (name === "subagent") return { action: "list" };
  if (name === "recall") return { id: "deadbeef0000" };
  if (name === "until_done_task_update") return { id: "T-001", patch: { status: "in_progress" } };
  if (name === "custom_dynamic_tool") return { foo: "bar" };
  return { path: "package.json" };
}

function shapeText(shape, name) {
  const args = sampleArguments(name);
  if (shape === "array") {
    return JSON.stringify([{ id: `pi_tool_${name}_x`, name, arguments: args }]);
  }
  if (shape === "object") {
    return `I am going to call a tool now:\n${JSON.stringify({ id: `pi_tool_${name}_x`, name, arguments: args })}`;
  }
  if (shape === "openai") {
    return JSON.stringify({
      tool_calls: [{
        id: `call_${name}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    });
  }
  return `工具调用如下：\n${JSON.stringify({ function_call: { name, arguments: args } })}`;
}

test("runtime and smoke boundaries reject canonical tool-like final shapes in parity", () => {
  const toolNames = [
    "read",
    "bash",
    "web_fetch",
    "fffind",
    "ffgrep",
    "mcp",
    "subagent",
    "recall",
    "until_done_task_update",
    "custom_dynamic_tool",
  ];
  const shapes = {
    array: { code: "tool_call_like_json_array", matchedShape: "json_array_item" },
    object: { code: "tool_call_like_json_object", matchedShape: "json_object" },
    openai: { code: "openai_tool_calls_final", matchedShape: "openai_tool_calls" },
    function_call: { code: "function_call_final", matchedShape: "function_call" },
  };

  for (const name of toolNames) {
    for (const [shape, expected] of Object.entries(shapes)) {
      expectFinding(
        { text: shapeText(shape, name), selectedToolNames: [name] },
        { ...expected, name },
      );
    }
  }
});

test("tool and argument aliases remain detectable at the final boundary", () => {
  const fixtures = [
    { value: { tool: "dynamic", args: {} }, name: "dynamic", code: "tool_call_like_json_object", shape: "json_object" },
    { value: { tool_name: "dynamic", input: {} }, name: "dynamic", code: "tool_call_like_json_object", shape: "json_object" },
    { value: { function_name: "dynamic", parameters: {} }, name: "dynamic", code: "tool_call_like_json_object", shape: "json_object" },
    { value: { name: "dynamic", arguments_json: "{}" }, name: "dynamic", code: "tool_call_like_json_object", shape: "json_object" },
    {
      value: { function: { name: "dynamic", arguments: "{}" } },
      name: "dynamic",
      code: "function_call_final",
      shape: "function",
    },
  ];

  for (const fixture of fixtures) {
    expectFinding(
      { text: JSON.stringify(fixture.value), selectedToolNames: [" dynamic ", "", null] },
      { code: fixture.code, matchedShape: fixture.shape, name: fixture.name },
    );
  }
});

test("selected, all-tool, reserved-name, and Pi-id evidence are recognized", () => {
  expectFinding(
    { text: '{"name":"selected_tool","arguments":{}}', selectedToolNames: ["selected_tool"] },
    { code: "tool_call_like_json_object", matchedShape: "json_object", name: "selected_tool" },
  );
  expectFinding(
    { text: '{"name":"all_tool","arguments":{}}', selectedToolNames: ["read"], allToolNames: ["all_tool"] },
    { code: "tool_call_like_json_object", matchedShape: "json_object", name: "all_tool" },
  );
  expectFinding(
    { text: '{"name":"until_done_custom","arguments":{}}' },
    { code: "tool_call_like_json_object", matchedShape: "json_object", name: "until_done_custom" },
  );

  for (const idField of ["id", "tool_call_id", "call_id"]) {
    expectFinding(
      { text: JSON.stringify({ name: "unselected_tool", arguments: {}, [idField]: "pi_tool_unselected_x" }) },
      { code: "tool_call_like_json_object", matchedShape: "json_object", name: "unselected_tool" },
    );
  }
});

test("protocol wrappers are rejected even when their tool name is not selected", () => {
  expectFinding(
    { text: '{"kind":"tool_call","name":"hidden_tool","arguments":{}}' },
    { code: "tool_call_like_json_object", matchedShape: "json_action_tool_call", name: "hidden_tool" },
  );
  expectFinding(
    {
      text: JSON.stringify({
        tool_calls: [null, { name: "hidden_tool", arguments: {} }],
      }),
    },
    { code: "openai_tool_calls_final", matchedShape: "openai_tool_calls", name: "hidden_tool" },
  );
  expectFinding(
    { text: '{"function_call":{"name":"hidden_tool","arguments":{}}}' },
    { code: "function_call_final", matchedShape: "function_call", name: "hidden_tool" },
  );
  expectFinding(
    { text: '{"function":{"name":"hidden_tool","arguments":{}}}' },
    { code: "function_call_final", matchedShape: "function", name: "hidden_tool" },
  );
});

test("array wrappers preserve their outer finding code without losing nested protocol shapes", () => {
  expectFinding(
    { text: '[null,1,{"name":"read","arguments":{"path":"package.json"}}]', selectedToolNames: ["read"] },
    { code: "tool_call_like_json_array", matchedShape: "json_array_item", name: "read" },
  );
  expectFinding(
    { text: '[{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}]' },
    { code: "tool_call_like_json_array", matchedShape: "json_action_tool_call", name: "read" },
  );
  expectFinding(
    {
      text: '[{"tool_calls":[{"function":{"name":"read","arguments":"{\\"path\\":\\"package.json\\"}"}}]}]',
    },
    { code: "openai_tool_calls_final", matchedShape: "openai_tool_calls", name: "read" },
  );
});

test("ordinary product JSON and malformed tool arguments remain valid final content", () => {
  const safeTexts = [
    '[{"name":"普通商品","arguments":{"销量":12}}]',
    '{"name":"商品A","arguments":{"卖点":["温和","便携"]}}',
    '{"name":"custom_dynamic_tool","arguments":{"foo":"bar"}}',
    '{"name":"read"}',
    '{"name":"read","arguments":[]}',
    '{"name":"read","arguments":"[]"}',
    '{"name":"read","arguments":"{bad}"}',
    '{"tool_calls":[null,{"function":{"name":"read","arguments":"[]"}}]}',
    '{"function_call":"not-an-object"}',
    '["plain",1,null]',
  ];

  for (const text of safeTexts) {
    const input = { text, selectedToolNames: ["read"] };
    assert.deepEqual(detectWithParity(input), { ok: true }, text);
    assert.equal(containsToolCallLikeFinal(input), false, text);
  }
});

test("the scanner handles prose, escaping, malformed candidates, and duplicate JSON", () => {
  const toolCall = '{"name":"read","arguments":{"path":"package.json"}}';
  for (const text of [
    `prefix {bad} middle ${toolCall}`,
    `{] malformed before ${toolCall}`,
    `{"text":"brace } and escaped quote \\\" stays inside"} ${toolCall}`,
    `{} {} ${toolCall}`,
    `incomplete {"name":"read" before ${toolCall}`,
  ]) {
    expectFinding(
      { text, selectedToolNames: ["read"] },
      { code: "tool_call_like_json_object", matchedShape: "json_object", name: "read" },
    );
  }
});

test("scanner work remains bounded by candidate and character limits", () => {
  assert.deepEqual(detectWithParity({ text: "{} ".repeat(20), selectedToolNames: ["read"] }), { ok: true });

  const beyondScanLimit = `${"x".repeat(12000)}{"name":"read","arguments":{"path":"package.json"}}`;
  assert.deepEqual(detectWithParity({ text: beyondScanLimit, selectedToolNames: ["read"] }), { ok: true });
});

test("containsToolCallLikeFinal is a strict boolean wrapper", () => {
  const toolLike = {
    text: '{"name":"read","arguments":{"path":"package.json"}}',
    selectedToolNames: ["read"],
  };
  const finalText = { text: "Concrete final answer." };
  assert.equal(containsToolCallLikeFinal(toolLike), true);
  assert.equal(smokeBoundary.containsToolCallLikeFinal(toolLike), true);
  assert.equal(containsToolCallLikeFinal(finalText), false);
  assert.equal(smokeBoundary.containsToolCallLikeFinal(finalText), false);
});
