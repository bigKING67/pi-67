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

  const noEligibleTool = selectToolsWithSummary(
    [tool("mcp", "Connect to an MCP server")],
    "Do not use mcp.",
    1,
  );
  assert.deepEqual(noEligibleTool.selectedTools, []);
  assert.ok(noEligibleTool.summary.omitted[0].reasonCodes.includes("prompt_tool_forbidden"));
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

test("browser preference never restores an explicitly forbidden MCP gateway", () => {
  const result = selectToolsWithSummary(
    [
      tool("mcp", "Connect to browser67"),
      tool("browser_execute_js", "Inspect a browser67 managed tab"),
      tool("bash", "Run shell commands"),
    ],
    "Do not use mcp; use browser67 direct tools to inspect the current tab.",
    1,
  );

  assert.deepEqual(result.selectedTools.map((item) => item.name), ["browser_execute_js"]);
  const omittedMcp = result.summary.omitted.find((item) => item.name === "mcp");
  assert.ok(omittedMcp?.reasonCodes.includes("prompt_tool_forbidden"));
});

test("explicit exclusive constraints outrank browser and vision preferences", () => {
  const browserResult = selectToolsWithSummary(
    [tool("bash"), tool("mcp", "Connect to browser67"), tool("browser_execute_js")],
    "Only use bash to inspect the browser67 current tab. Do not use mcp.",
    2,
  );
  assert.deepEqual(browserResult.selectedTools.map((item) => item.name), ["bash"]);

  const visionResult = selectToolsWithSummary(
    [tool("read", "Read a file"), tool("vision_read", "Analyze an image")],
    "Only use read to inspect screenshot /tmp/image.png.",
    2,
  );
  assert.deepEqual(visionResult.selectedTools.map((item) => item.name), ["read"]);
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
