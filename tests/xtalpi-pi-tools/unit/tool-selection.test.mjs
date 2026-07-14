import assert from "node:assert/strict";
import test from "node:test";

import {
  selectToolsWithSummary,
  serializeSelectedTools,
} from "../../../extensions/xtalpi-pi-tools/tool-selection.ts";

function tool(name, description = `${name} test tool`) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

test("tool selection normalizes names, removes duplicates, and preserves stable order below the limit", () => {
  const result = selectToolsWithSummary([
    tool(" read "),
    tool("read"),
    tool("bash"),
    { name: "" },
  ], "Inspect package.json", 8);

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["read", "bash"]);
  assert.equal(result.summary.totalToolCount, 4);
  assert.equal(result.summary.validToolCount, 2);
  assert.equal(result.summary.clipped, false);
});

test("an exclusive tool instruction selects only explicitly allowed tools", () => {
  const result = selectToolsWithSummary(
    [tool("read", "Read a file"), tool("bash", "Run a shell command"), tool("web_fetch", "Fetch a URL")],
    "Only use read to inspect package.json. Do not use bash or web_fetch.",
    3,
  );

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["read"]);
  assert.ok(result.summary.selected[0].reasonCodes.includes("prompt_tool_exclusive"));
  assert.deepEqual(result.summary.omitted.map((item) => item.name).sort(), ["bash", "web_fetch"]);
});

test("a forbidden tool cannot be restored by a recovery boost", () => {
  const result = selectToolsWithSummary(
    [tool("read", "Read a file"), tool("fffind", "Find files")],
    "Do not use fffind. Only use read for missing.txt.",
    1,
    { boostedToolNames: ["fffind"], boostReasonCode: "recovery_path_discovery" },
  );

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["read"]);
  const omittedFind = result.summary.omitted.find((item) => item.name === "fffind");
  assert.ok(omittedFind?.reasonCodes.includes("prompt_tool_forbidden"));
  assert.ok(!omittedFind?.reasonCodes.includes("recovery_path_discovery"));
});

test("image paths prefer the semantic vision bridge and penalize ordinary file tools", () => {
  const result = selectToolsWithSummary(
    [tool("read", "Read a local file"), tool("vision_read", "Analyze an image")],
    "请分析截图 /tmp/codex-clipboard-example.png 的内容",
    2,
  );

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["vision_read"]);
  assert.ok(result.summary.selected[0].reasonCodes.includes("vision_bridge_route"));
  assert.ok(result.summary.selected[0].reasonCodes.includes("vision_bridge_task"));
});

test("browser tasks prefer the MCP gateway instead of bash", () => {
  const result = selectToolsWithSummary(
    [tool("bash", "Run shell commands"), tool("mcp", "Connect to tmwd_browser")],
    "使用 browser67 打开 https://example.com 并截图",
    2,
  );

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["mcp"]);
  assert.ok(result.summary.selected[0].reasonCodes.includes("browser_mcp_route"));
  assert.ok(result.summary.selected[0].reasonCodes.includes("prompt_browser_url_open"));
});

test("tool serialization remains bounded for large selected schemas", () => {
  const selected = Array.from({ length: 16 }, (_, index) => ({
    name: `tool_${index}`,
    description: "x".repeat(500),
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (__, propertyIndex) => [
          `property_${propertyIndex}`,
          { type: "string", description: "y".repeat(200) },
        ]),
      ),
    },
  }));

  const serialized = serializeSelectedTools(selected, 1000);
  assert.ok(serialized.length <= 18_000);
  assert.match(serialized, /Available Pi tools \(16\/1000/);
});
