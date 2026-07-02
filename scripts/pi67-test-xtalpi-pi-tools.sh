#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node --no-warnings - "$REPO_ROOT" <<'NODE'
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const repoRoot = process.argv[2];
  const ext = (name) => pathToFileURL(path.join(repoRoot, "extensions", "xtalpi-pi-tools", name)).href;

  const parser = await import(ext("parser.ts"));
  const serializer = await import(ext("serializer.ts"));
  const provider = await import(ext("index.ts"));

  const valid = parser.parseToolCall('<pi_tool_call>\n{"name":"read","arguments":{"path":"package.json"}}\n</pi_tool_call>');
  assert.equal(valid.kind, "tool_call");
  assert.equal(valid.call.name, "read");
  assert.deepEqual(valid.call.arguments, { path: "package.json" });

  const fenced = parser.parseToolCall("<pi_tool_call>\n```json\n{\"name\":\"bash\",\"arguments\":{\"command\":\"pwd\"}}\n```\n</pi_tool_call>");
  assert.equal(fenced.kind, "tool_call");
  assert.equal(fenced.call.name, "bash");

  const multi = parser.parseToolCall('<pi_tool_call>{"name":"read","arguments":{}}</pi_tool_call><pi_tool_call>{"name":"bash","arguments":{}}</pi_tool_call>');
  assert.equal(multi.kind, "error");
  assert.equal(multi.code, "multiple_tool_calls");

  const unknownField = parser.parseToolCall('<pi_tool_call>{"name":"read","arguments":{},"extra":1}</pi_tool_call>');
  assert.equal(unknownField.kind, "error");
  assert.equal(unknownField.code, "unknown_top_level_field");

  const context = {
    systemPrompt: "system base",
    tools: [
      { name: "read", description: "Read a file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } } } },
    ],
    messages: [
      { role: "user", content: "read package.json" },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "package.json" } }] },
      { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: [{ type: "text", text: "{\"name\":\"pi-extensions\"}" }] },
    ],
  };

  const messages = serializer.serializeContextToXtalpiMessages(context, {
    maxTools: 8,
    maxToolResultChars: 2000,
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Available Pi tools/);
  assert.ok(messages.some((msg) => msg.role === "user" && msg.content.includes("<pi_tool_result>")));
  assert.ok(!messages.some((msg) => msg.role === "tool"));

  const payload = provider.buildChatCompletionPayload(
    { id: "deepseek-v4-pro", maxTokens: 32768 },
    messages,
    { maxTokens: 4096 },
  );
  assert.equal(payload.stream, false);
  assert.equal(payload.max_tokens, 4096);
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "tools"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "tool_choice"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "parallel_tool_calls"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "thinking"));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "reasoning_effort"));
  assert.ok(!JSON.stringify(payload.messages).includes('"role":"tool"'));

  process.env.XTALPI_PI_TOOLS_API_KEY = "test-key";
  process.env.XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES = "2";
  process.env.XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES = "4";

  let registeredProvider;
  provider.default({
    registerProvider(id, config) {
      assert.equal(id, "xtalpi-pi-tools");
      registeredProvider = config;
    },
  });
  assert.ok(registeredProvider?.streamSimple);

  const repeatedToolEnvelope = {
    choices: [
      {
        message: {
          role: "assistant",
          content: '<pi_tool_call>\n{"name":"read","arguments":{"path":"package.json"}}\n</pi_tool_call>',
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  let fetchCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify(repeatedToolEnvelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const repeatedContext = {
      systemPrompt: "system base",
      tools: [
        { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: "read package.json" },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "package.json" } }] },
        { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: [{ type: "text", text: "{\"name\":\"pi-extensions\"}" }] },
      ],
    };
    const repeatedStream = registeredProvider.streamSimple(
      {
        id: "deepseek-v4-pro",
        maxTokens: 32768,
        api: "xtalpi-pi-tools",
        provider: "xtalpi-pi-tools",
        baseUrl: "https://example.invalid/v1",
      },
      repeatedContext,
      {},
    );
    const repeatedFinal = await repeatedStream.result();
    const repeatedText = repeatedFinal.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.equal(fetchCount, 3);
    assert.equal(repeatedFinal.stopReason, "stop");
    assert.match(repeatedText, /重复请求同一个工具/);
    assert.ok(!repeatedFinal.content.some((block) => block.type === "toolCall"));
  } finally {
    global.fetch = originalFetch;
  }

  console.log("xtalpi-pi-tools tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
