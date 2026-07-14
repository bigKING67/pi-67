import assert from "node:assert/strict";
import test from "node:test";

import {
  formatToolNameForPrompt,
  formatToolNamesForPrompt,
  neutralizeProtocolMarkers,
  safeBlockText,
  safeInlineText,
  safeJsonStringify,
  truncateText,
} from "../../../extensions/xtalpi-pi-tools/text-safety.ts";

test("text truncation treats every finite maximum as a hard content boundary", () => {
  assert.equal(truncateText("abcdef", 6), "abcdef");
  assert.equal(truncateText("abcdef", 3.9), "abc\n\n[truncated 3 chars by xtalpi-pi-tools]");
  assert.equal(truncateText("abcdef", 0), "[truncated 6 chars by xtalpi-pi-tools]");
  assert.equal(truncateText("abcdef", -1), "[truncated 6 chars by xtalpi-pi-tools]");
  assert.equal(truncateText("abcdef", Number.NaN), "[truncated 6 chars by xtalpi-pi-tools]");
  assert.equal(truncateText("abcdef", Number.POSITIVE_INFINITY), "abcdef");
});

test("block text removes control characters and neutralizes executable protocol markup", () => {
  const safe = safeBlockText(
    "a\u0000b <pi_tool_call attr=\"x\">call</pi_tool_call> " +
      "<pi_tool_result>result</pi_tool_result> <pi_tool_call_history>history</pi_tool_call_history>",
    1_000,
  );
  assert.equal(safe.includes("\u0000"), false);
  assert.equal(safe.includes("<pi_tool_"), false);
  assert.match(safe, /\[literal pi_tool_call open tag\]/);
  assert.match(safe, /\[literal pi_tool_result close tag\]/);
  assert.match(safe, /\[literal pi_tool_call_history open tag\]/);
});

test("previous tool history markers are rendered as inert labels", () => {
  const safe = neutralizeProtocolMarkers(
    "<previous_pi_tool_call>one</previous_pi_tool_call> " +
      "[previous_pi_tool_call]two[/previous_pi_tool_call]",
  );
  assert.equal(safe.includes("<previous_pi_tool_call>"), false);
  assert.equal(safe.includes("[previous_pi_tool_call]"), false);
  assert.match(safe, /\[literal previous_pi_tool_call open marker\]/);
  assert.match(safe, /\[literal previous_pi_tool_call close marker\]/);
});

test("inline text is single-line, collapsed, trimmed, and bounded", () => {
  assert.equal(safeInlineText("  alpha\n\tbeta   gamma  ", 100), "alpha beta gamma");
  assert.equal(
    safeInlineText("abcdef", 3),
    "abc [truncated 3 chars by xtalpi-pi-tools]",
  );
});

test("safe JSON serialization handles undefined and circular values deterministically", () => {
  assert.equal(safeJsonStringify({ b: 2 }), '{"b":2}');
  assert.equal(safeJsonStringify(undefined), "null");
  const circular = {};
  circular.self = circular;
  assert.equal(safeJsonStringify(circular), '"[unserializable JSON value]"');
});

test("tool names are JSON-quoted, bounded, and cardinality-limited", () => {
  assert.equal(formatToolNameForPrompt(" read\n"), '"read"');
  assert.equal(formatToolNamesForPrompt([], 2), "(none)");
  assert.equal(formatToolNamesForPrompt(["read", "bash", "write"], 2), '"read", "bash"');
});
