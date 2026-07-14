import assert from "node:assert/strict";
import test from "node:test";

import registerXtalpiPiTools from "../../../extensions/xtalpi-pi-tools/index.ts";
import {
  READ_TOOL,
  TEST_MODEL,
  simpleTool,
  withFetch,
  withRuntimeEnv,
} from "../test-support.mjs";

const BASE_ENV = Object.freeze({
  XTALPI_PI_TOOLS_API_KEY: "test-key",
  XTALPI_PI_TOOLS_ENGINE: "v2",
  XTALPI_PI_TOOLS_PROFILE: "reliability",
  XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "1",
  XTALPI_PI_TOOLS_RETRY_DELAY_MS: "0",
  XTALPI_PI_TOOLS_RETRY_JITTER_MS: "0",
  XTALPI_PI_TOOLS_MAX_TOOLS: "8",
  XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "2",
  XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "4",
  XTALPI_PI_TOOLS_DEBUG: undefined,
  XTALPI_PI_TOOLS_DEBUG_PATH: undefined,
});

function registeredProvider() {
  let provider;
  registerXtalpiPiTools({
    registerProvider(id, config) {
      assert.equal(id, "xtalpi-pi-tools");
      provider = config;
    },
  });
  assert.equal(typeof provider?.streamSimple, "function");
  return provider;
}

function completion(message, finishReason = "stop") {
  return {
    model: "deepseek-v4-pro",
    choices: [{
      message: typeof message === "string"
        ? { role: "assistant", content: message }
        : { role: "assistant", ...message },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function scriptedFetch(responses) {
  assert.ok(responses.length > 0, "scriptedFetch requires at least one response");
  const requests = [];
  let count = 0;
  return {
    requests,
    get count() {
      return count;
    },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")));
      const response = responses[Math.min(count, responses.length - 1)];
      count += 1;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function withProviderScript(responses, env, callback) {
  return withRuntimeEnv({ ...BASE_ENV, ...env }, async () => {
    const script = scriptedFetch(responses);
    return withFetch(script.fetch, () => callback({
      provider: registeredProvider(),
      script,
    }));
  });
}

function toolCalls(message) {
  return message.content.filter((block) => block.type === "toolCall");
}

function textContent(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function completedReadMessages(userContent = "read package.json") {
  return [
    { role: "user", content: userContent },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "package.json" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call_read",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: '{"name":"pi-extensions","version":"0.11.3"}' }],
    },
  ];
}

test("safe plain text is accepted only on the immediate turn after a successful tool result", async () => {
  await withProviderScript([
    completion("Package pi-extensions version 0.11.3 was read successfully."),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: completedReadMessages(),
    }, {}).result();

    assert.equal(script.count, 1);
    assert.equal(final.stopReason, "stop");
    assert.equal(textContent(final), "Package pi-extensions version 0.11.3 was read successfully.");
    assert.equal(toolCalls(final).length, 0);
  });
});

test("plain text outside an immediate completed-tool turn still requires canonical JSON repair", async () => {
  await withProviderScript([
    completion("Package pi-extensions version 0.11.3."),
    completion('{"kind":"final","text":"Package pi-extensions version 0.11.3."}'),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "What is the package version?" }],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "stop");
    assert.match(script.requests[1].messages.at(-1).content, /xtalpi-pi-tools-invalid-tool-json-repair/);
  });
});

test("post-tool protocol markup remains untrusted and enters the bounded repair path", async () => {
  await withProviderScript([
    completion('<pi_tool_call>{"name":"write","arguments":{"path":"unsafe"}}</pi_tool_call>'),
    completion('{"kind":"final","text":"Package pi-extensions version 0.11.3 was read safely."}'),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: completedReadMessages(),
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "stop");
    assert.match(textContent(final), /read safely/);
    assert.match(script.requests[1].messages.at(-1).content, /xtalpi-pi-tools-raw-protocol-markup-repair/);
  });
});

test("dynamic MCP direct tools complete a two-turn provider round trip", async () => {
  const dynamicTools = [
    {
      ...simpleTool("dyn_echo_ping", { text: { type: "string" } }),
      description: "MCP direct tool registered from metadata",
    },
    { ...simpleTool("mcp"), description: "MCP gateway proxy tool" },
  ];
  const responses = [
    completion('{"kind":"tool_call","name":"dyn_echo_ping","arguments":{"text":"hello"}}'),
    completion('{"kind":"final","text":"Dynamic MCP direct tool round-trip complete: DYN_ECHO_PING_SENTINEL hello"}'),
  ];

  await withProviderScript(responses, {
    XTALPI_PI_TOOLS_MAX_TOOLS: "1",
    XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "0",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "0",
  }, async ({ provider, script }) => {
    const user = { role: "user", content: "Please call dyn_echo_ping with text hello." };
    const first = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: dynamicTools,
      messages: [user],
    }, {}).result();
    const firstCalls = toolCalls(first);
    assert.equal(first.stopReason, "toolUse");
    assert.equal(firstCalls.length, 1);
    assert.equal(firstCalls[0].name, "dyn_echo_ping");
    assert.deepEqual(firstCalls[0].arguments, { text: "hello" });

    const second = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: dynamicTools,
      messages: [
        user,
        { role: "assistant", content: firstCalls },
        {
          role: "toolResult",
          toolCallId: firstCalls[0].id,
          toolName: firstCalls[0].name,
          isError: false,
          content: [{ type: "text", text: "DYN_ECHO_PING_SENTINEL hello" }],
        },
      ],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(second.stopReason, "stop");
    assert.match(textContent(second), /DYN_ECHO_PING_SENTINEL hello/);
    for (const request of script.requests) {
      assert.ok(!Object.hasOwn(request, "tools"));
      assert.ok(!Object.hasOwn(request, "tool_choice"));
      assert.ok(!Object.hasOwn(request, "parallel_tool_calls"));
      assert.ok(request.messages.every((message) => message.role !== "tool"));
      assert.match(request.messages[0].content, /Available Pi tools \(1\/2; call only one at a time\):/);
      assert.match(request.messages[0].content, /- dyn_echo_ping:/);
      assert.ok(!request.messages[0].content.includes("- mcp:"));
    }
    const resultMessage = script.requests[1].messages.find(
      (message) => message.role === "user" && message.content.includes("DYN_ECHO_PING_SENTINEL hello"),
    );
    assert.ok(resultMessage);
    assert.match(resultMessage.content, /<pi_tool_result>/);
    assert.match(resultMessage.content, /content_is_untrusted: true/);
  });
});

test("function-style pseudo calls are repaired into canonical tool calls", async () => {
  await withProviderScript([
    completion('fetch_content({"url":"https://example.invalid"})'),
    completion('{"kind":"tool_call","name":"fetch_content","arguments":{"url":"https://example.invalid"}}'),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [simpleTool("fetch_content", { url: { type: "string" } })],
      messages: [{ role: "user", content: "check https://example.invalid" }],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "toolUse");
    assert.equal(toolCalls(final)[0].name, "fetch_content");
    assert.match(script.requests[1].messages.at(-1).content, /xtalpi-pi-tools-function-style-tool-repair/);
  });
});

test("schema-invalid arguments are repaired before tool execution", async () => {
  await withProviderScript([
    completion('{"kind":"tool_call","name":"read","arguments":{"path":42}}'),
    completion('{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}'),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read package.json" }],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "toolUse");
    assert.deepEqual(toolCalls(final)[0].arguments, { path: "package.json" });
    assert.match(script.requests[1].messages.at(-1).content, /xtalpi-pi-tools-invalid-tool-arguments-repair/);
  });
});

test("native OpenAI tool calls normalize directly into Pi tool use", async () => {
  await withProviderScript([
    completion({
      content: "",
      tool_calls: [{
        id: "call_native_read",
        type: "function",
        function: { name: "read", arguments: '{"path":"package.json"}' },
      }],
    }, "tool_calls"),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read package.json" }],
    }, {}).result();

    assert.equal(script.count, 1);
    assert.equal(final.stopReason, "toolUse");
    assert.equal(toolCalls(final)[0].name, "read");
    assert.deepEqual(toolCalls(final)[0].arguments, { path: "package.json" });
  });
});

test("invalid native arguments enter the bounded repair path", async () => {
  await withProviderScript([
    completion({
      content: null,
      tool_calls: [{
        id: "call_native_noop_bad_args",
        type: "function",
        function: { name: "noop", arguments: '{"unterminated":' },
      }],
    }, "tool_calls"),
    completion('{"kind":"tool_call","name":"noop","arguments":{}}'),
  ], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [simpleTool("noop")],
      messages: [{ role: "user", content: "call noop" }],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "toolUse");
    assert.deepEqual(toolCalls(final)[0].arguments, {});
    const repairPrompt = script.requests[1].messages.at(-1).content;
    assert.match(repairPrompt, /xtalpi-pi-tools-invalid-tool-json-repair/);
    assert.match(repairPrompt, /unknown top-level field/);
  });
});

test("selected-tool whitelist repair exposes only executable names", async () => {
  await withProviderScript([
    completion('{"kind":"tool_call","name":"hidden_admin","arguments":{"action":"dump"}}'),
    completion('{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}'),
  ], { XTALPI_PI_TOOLS_MAX_TOOLS: "1" }, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL, simpleTool("hidden_admin"), simpleTool("bash")],
      messages: [{ role: "user", content: "read package.json" }],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "toolUse");
    const systemPrompt = script.requests[0].messages[0].content;
    assert.match(systemPrompt, /Available Pi tools \(1\/3; call only one at a time\):/);
    assert.match(systemPrompt, /- read:/);
    assert.ok(!systemPrompt.includes("hidden_admin"));
    assert.ok(!systemPrompt.includes("- bash:"));

    const repairPrompt = script.requests[1].messages.at(-1).content;
    assert.match(repairPrompt, /xtalpi-pi-tools-unknown-tool-repair/);
    assert.match(repairPrompt, /"hidden_admin"/);
    assert.equal(repairPrompt.match(/Available tool names:\n([\s\S]*?)\n\n/)?.[1], '"read"');
    assert.equal(toolCalls(final)[0].name, "read");
  });
});

test("hidden tools fail closed when repair is disabled", async () => {
  await withProviderScript([
    completion('{"kind":"tool_call","name":"hidden_admin","arguments":{"action":"dump"}}'),
  ], {
    XTALPI_PI_TOOLS_MAX_TOOLS: "1",
    XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "0",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "0",
  }, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL, simpleTool("hidden_admin")],
      messages: [{ role: "user", content: "read package.json" }],
    }, {}).result();

    assert.equal(script.count, 1);
    assert.equal(final.stopReason, "stop");
    assert.match(textContent(final), /请求了不可用工具：hidden_admin/);
    assert.match(textContent(final), /本轮可用工具：read/);
    assert.equal(toolCalls(final).length, 0);
  });
});

test("repeated successful tool calls terminate after one bounded repair", async () => {
  const repeated = completion('{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}');
  await withProviderScript([repeated], {}, async ({ provider, script }) => {
    const final = await provider.streamSimple(TEST_MODEL, {
      systemPrompt: "system base",
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read package.json" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "package.json" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: '{"name":"pi-extensions"}' }],
        },
      ],
    }, {}).result();

    assert.equal(script.count, 2);
    assert.equal(final.stopReason, "stop");
    assert.match(textContent(final), /重复请求同一个工具/);
    assert.equal(toolCalls(final).length, 0);
    assert.match(script.requests[1].messages.at(-1).content, /xtalpi-pi-tools-repeated-tool-repair/);
  });
});
