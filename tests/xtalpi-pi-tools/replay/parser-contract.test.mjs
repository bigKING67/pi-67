import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  hasToolCall,
  parseJsonAction,
  parseToolCall,
  stripToolCall,
} from "../../../extensions/xtalpi-pi-tools/parser.ts";
import {
  buildParseErrorRepairPlan,
  canRecoverEmptyResponse,
  canRecoverRepair,
} from "../../../extensions/xtalpi-pi-tools/recovery-decision.ts";

const fixtureFile = fileURLToPath(new URL(
  "../../../extensions/xtalpi-pi-tools/fixtures/replay-cases.json",
  import.meta.url,
));
const replayFixtures = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));

function assertParserFixture(fixture) {
  const actual = parseToolCall(fixture.input);
  const expected = fixture.expect;
  assert.equal(actual.kind, expected.kind, fixture.name);
  if (expected.kind === "tool_call") {
    assert.equal(actual.call.name, expected.name, fixture.name);
    assert.deepEqual(actual.call.arguments, expected.arguments ?? {}, fixture.name);
    if (Object.hasOwn(expected, "before")) assert.equal(actual.before, expected.before, fixture.name);
    if (Object.hasOwn(expected, "after")) assert.equal(actual.after, expected.after, fixture.name);
    for (const expectedWarning of expected.warningsContain ?? []) {
      assert.ok(actual.warnings.some((warning) => warning.includes(expectedWarning)), fixture.name);
    }
    return;
  }
  if (expected.kind === "error") assert.equal(actual.code, expected.code, fixture.name);
}

test("legacy parser replay fixtures remain compatible", async (t) => {
  assert.ok(Array.isArray(replayFixtures.parser));
  assert.ok(replayFixtures.parser.length >= 32);
  for (const fixture of replayFixtures.parser) {
    await t.test(fixture.name, () => assertParserFixture(fixture));
  }
});

test("strict JSON action accepts only canonical tool and final envelopes", () => {
  const toolCall = parseJsonAction('{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}');
  assert.equal(toolCall.kind, "tool_call");
  assert.equal(toolCall.call.name, "read");
  assert.deepEqual(toolCall.call.arguments, { path: "package.json" });

  const fencedTool = parseJsonAction('```json\n{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}\n```');
  assert.equal(fencedTool.kind, "tool_call");
  assert.equal(fencedTool.call.name, "read");

  const fencedFinal = parseJsonAction('```json\n{"kind":"final","text":"package name is pi-extensions"}\n```');
  assert.deepEqual(fencedFinal, { kind: "none", text: "package name is pi-extensions" });

  const legacyMarkup = parseJsonAction('<pi_tool_call>\n{"name":"read","arguments":{"path":"package.json"}}\n</pi_tool_call>');
  assert.equal(legacyMarkup.kind, "error");
  assert.equal(legacyMarkup.code, "raw_protocol_markup");

  const fencedLegacyMarkup = parseJsonAction('```json\n<pi_tool_call>\n{"name":"read","arguments":{"path":"package.json"}}\n</pi_tool_call>\n```');
  assert.equal(fencedLegacyMarkup.kind, "error");
  assert.equal(fencedLegacyMarkup.code, "raw_protocol_markup");

  const legacyObject = parseJsonAction('{"name":"read","arguments":{"path":"package.json"}}');
  assert.equal(legacyObject.kind, "error");
  assert.equal(legacyObject.code, "invalid_envelope");
});

test("selected direct-kind JSON actions enter targeted repair without weakening the standalone parser", () => {
  const directKind = parseJsonAction(
    '{"kind":"bash","command":"pi update --extensions","timeout":120}',
    { selectedToolNames: ["bash", "read"] },
  );
  assert.equal(directKind.kind, "error");
  assert.equal(directKind.code, "selected_tool_direct_kind");

  const repair = buildParseErrorRepairPlan(directKind, ["bash", "read"]);
  assert.equal(repair.event, "recovery.selected_tool_direct_kind");
  assert.match(repair.prompt, /xtalpi-pi-tools-selected-tool-direct-kind-repair/);
  assert.match(repair.prompt, /Move the tool name to "name"/);

  const unselected = parseJsonAction(
    '{"kind":"bash","command":"pi update --extensions","timeout":120}',
    { selectedToolNames: ["read"] },
  );
  assert.equal(unselected.kind, "error");
  assert.equal(unselected.code, "invalid_envelope");

  const withoutRuntimeContext = parseJsonAction(
    '{"kind":"bash","command":"pi update --extensions","timeout":120}',
  );
  assert.equal(withoutRuntimeContext.kind, "error");
  assert.equal(withoutRuntimeContext.code, "invalid_envelope");
});

test("strict JSON action repairs malformed final text without relaxing tool calls", () => {
  const malformedFinal = parseJsonAction('{"kind":"final","text":"明白了，"洗护发"是美妆个护逻辑，不是纸品日化。"}');
  assert.equal(malformedFinal.kind, "none");
  assert.match(malformedFinal.text, /"洗护发"/);
  assert.match(malformedFinal.text, /美妆个护逻辑/);

  const fencedMalformedFinal = parseJsonAction('```json\n{"kind":"final","text":"明白了，"洗护发"是美妆个护逻辑，不是纸品日化。"}\n```');
  assert.equal(fencedMalformedFinal.kind, "none");
  assert.match(fencedMalformedFinal.text, /"洗护发"/);

  const malformedTool = parseJsonAction('{"kind":"tool_call","name":"read","arguments":{"path":"package.json","note":"读"这个"文件"}}');
  assert.equal(malformedTool.kind, "error");
  assert.equal(malformedTool.code, "invalid_json");
});

test("malformed Windows bash JSON enters a targeted repair without executing ambiguous text", () => {
  const malformed = String.raw`{"kind":"tool_call","name":"bash","arguments":{"command":"ls -la "C:\Users\Groland\.agents\skills\investment-checklist\scripts\" 2>/dev/null || echo "scripts directory not found"","timeout":5}}`;
  const parsed = parseJsonAction(malformed, { selectedToolNames: ["bash"] });
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.code, "malformed_windows_bash_json");

  const repair = buildParseErrorRepairPlan(parsed, ["bash"]);
  assert.equal(repair.event, "recovery.malformed_windows_bash_json");
  assert.match(repair.prompt, /xtalpi-pi-tools-malformed-windows-bash-json-repair/);
  assert.match(repair.prompt, /\$HOME\/\.agents\/skills\/investment-checklist\/scripts/);
  assert.match(repair.prompt, /Every double quote inside the command string must be JSON-escaped/);
});

test("valid JSON keeps escaped shell quotes around Windows paths intact", () => {
  const command = String.raw`ls -la "C:\Users\Groland\.agents\skills"`;
  const parsed = parseJsonAction(JSON.stringify({
    kind: "tool_call",
    name: "bash",
    arguments: { command, timeout: 5 },
  }));

  assert.equal(parsed.kind, "tool_call");
  assert.equal(parsed.call.name, "bash");
  assert.equal(parsed.call.arguments.command, command);
  assert.equal(parsed.call.arguments.timeout, 5);
});

test("strict JSON action rejects ambiguous or invalid envelope fields", () => {
  const cases = [
    ['{"kind":"final","text":"done","extra":true}', "unknown_top_level_field"],
    ['{"kind":"final","text":42}', "invalid_envelope"],
    ['{"kind":"other","text":"done"}', "invalid_envelope"],
    ['{"kind":"tool_call","name":"","arguments":{}}', "invalid_name"],
    ['{"kind":"tool_call","name":"read","arguments":[]}', "invalid_arguments"],
    ['{"kind":"tool_call","name":"read","arguments":{},"extra":true}', "unknown_top_level_field"],
    ['[]', "invalid_json"],
    ['not json', "invalid_json"],
    ['fetch_content({"url":"https://example.invalid"})', "function_style_tool_call"],
  ];

  for (const [input, code] of cases) {
    const parsed = parseJsonAction(input);
    assert.equal(parsed.kind, "error", input);
    assert.equal(parsed.code, code, input);
  }
});

test("parser helpers expose and strip one executable tool call", () => {
  const text = 'Before\n<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>\nAfter';
  assert.equal(hasToolCall(text), true);
  assert.equal(hasToolCall("plain final answer"), false);
  assert.equal(stripToolCall(text), "Before\n\nAfter");
  assert.equal(stripToolCall("plain final answer"), "plain final answer");
});

test("parse error recovery decisions stay bounded and protocol-specific", () => {
  assert.equal(
    canRecoverEmptyResponse(
      { emptyRetries: 1, totalRecoveries: 1 },
      { maxEmptyRetries: 2, maxTotalRecoveries: 4 },
    ),
    true,
  );
  assert.equal(
    canRecoverEmptyResponse(
      { emptyRetries: 2, totalRecoveries: 2 },
      { maxEmptyRetries: 2, maxTotalRecoveries: 4 },
    ),
    false,
  );
  assert.equal(
    canRecoverRepair(
      { repairRetries: 1, totalRecoveries: 4 },
      { maxRepairRetries: 2, maxTotalRecoveries: 4 },
    ),
    false,
  );

  const functionStyle = parseToolCall('fetch_content({"url":"https://example.invalid"})');
  assert.equal(functionStyle.kind, "error");
  const functionRepair = buildParseErrorRepairPlan(functionStyle, ["read"]);
  assert.equal(functionRepair.event, "recovery.function_style_tool_call");
  assert.match(functionRepair.prompt, /xtalpi-pi-tools-function-style-tool-repair/);
  assert.match(functionRepair.prompt, /"read"/);

  const rawMarkup = parseToolCall("<pi_tool_result>unsafe</pi_tool_result>");
  assert.equal(rawMarkup.kind, "error");
  const rawRepair = buildParseErrorRepairPlan(rawMarkup, ["read"]);
  assert.equal(rawRepair.event, "recovery.raw_protocol_markup");
  assert.match(rawRepair.prompt, /xtalpi-pi-tools-raw-protocol-markup-repair/);

  const unknownField = parseToolCall('<pi_tool_call>{"name":"read","arguments":{},"extra":1}</pi_tool_call>');
  assert.equal(unknownField.kind, "error");
  const invalidJsonRepair = buildParseErrorRepairPlan(unknownField, ["read"]);
  assert.equal(invalidJsonRepair.event, "recovery.invalid_tool_json");
  assert.match(invalidJsonRepair.prompt, /unknown top-level field/);
  assert.match(invalidJsonRepair.prompt, /Available tool names:\n"read"/);
});
