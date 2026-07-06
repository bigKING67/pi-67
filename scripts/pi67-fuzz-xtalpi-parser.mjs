#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parser = await import(pathToFileURL(path.join(repoRoot, "extensions", "xtalpi-pi-tools", "parser.ts")).href);

const expectedArgs = { path: "package.json" };
const nameAliases = ["name", "tool", "tool_name", "function_name"];
const argumentAliases = ["arguments", "args", "input", "parameters", "arguments_json"];
const wrappers = [
  { name: "bare-json", wrap: (json) => json },
  { name: "pi-tool-call", wrap: (json) => `<pi_tool_call>\n${json}\n</pi_tool_call>` },
  { name: "uppercase-pi-tool-call", wrap: (json) => `<PI_TOOL_CALL>\n${json}\n</PI_TOOL_CALL>` },
  { name: "generic-tool-call", wrap: (json) => `<tool_call>\n${json}\n</tool_call>` },
];

let cases = 0;

function assertToolCall(input, label) {
  cases += 1;
  const actual = parser.parseToolCall(input);
  assert.equal(actual.kind, "tool_call", label);
  assert.equal(actual.call.name, "read", label);
  assert.deepEqual(actual.call.arguments, expectedArgs, label);
}

function assertError(input, code, label) {
  cases += 1;
  const actual = parser.parseToolCall(input);
  assert.equal(actual.kind, "error", label);
  assert.equal(actual.code, code, label);
}

for (const nameAlias of nameAliases) {
  for (const argumentAlias of argumentAliases) {
    for (const argumentValue of [expectedArgs, JSON.stringify(expectedArgs)]) {
      const envelope = JSON.stringify({
        [nameAlias]: "read",
        [argumentAlias]: argumentValue,
      });
      for (const wrapper of wrappers) {
        assertToolCall(wrapper.wrap(envelope), `${wrapper.name}:${nameAlias}:${argumentAlias}:${typeof argumentValue}`);
      }
    }
  }
}

assertToolCall(
  JSON.stringify({
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify(expectedArgs),
        },
      },
    ],
  }),
  "openai-tool-calls-function",
);

assertToolCall(
  JSON.stringify({
    function_call: {
      name: "read",
      arguments: JSON.stringify(expectedArgs),
    },
  }),
  "openai-function-call",
);

assertToolCall(
  `<pi_tool_call name="read">\n${JSON.stringify(expectedArgs)}\n</pi_tool_call>`,
  "attributed-arguments-body",
);

assertError(
  JSON.stringify({ name: "read", arguments: expectedArgs, unexpected: true }),
  "unknown_top_level_field",
  "unknown-top-level-field",
);
assertError(
  JSON.stringify({ name: "read", tool: "read", arguments: expectedArgs }),
  "invalid_envelope",
  "multiple-name-aliases",
);
assertError(
  JSON.stringify({ name: "read", arguments: expectedArgs, args: expectedArgs }),
  "invalid_envelope",
  "multiple-argument-aliases",
);
assertError(
  JSON.stringify({ name: "read", arguments: "" }),
  "invalid_arguments",
  "empty-argument-string",
);
assertError(
  JSON.stringify({
    tool_calls: [
      { function: { name: "read", arguments: JSON.stringify(expectedArgs) } },
      { function: { name: "read", arguments: JSON.stringify(expectedArgs) } },
    ],
  }),
  "multiple_tool_calls",
  "multiple-tool-calls",
);
assertError(
  `<pi_tool_call name="bash">\n${JSON.stringify({ name: "read", arguments: expectedArgs })}\n</pi_tool_call>`,
  "invalid_name",
  "attributed-name-mismatch",
);

console.log(`xtalpi parser matrix passed: cases=${cases}`);
