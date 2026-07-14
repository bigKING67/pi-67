import assert from "node:assert/strict";
import test from "node:test";

import { prepareProviderTurn } from "../../../extensions/xtalpi-pi-tools/turn/provider-turn-preparation.ts";

const MODEL = {
  id: "deepseek-v4-pro",
  maxTokens: 32768,
  api: "xtalpi-pi-tools",
  provider: "xtalpi-pi-tools",
  baseUrl: "https://example.invalid/v1",
};

function tool(name, description) {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
  };
}

async function withEnv(env, callback) {
  const previous = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function context(prompt, tools) {
  return {
    systemPrompt: "system base",
    tools,
    messages: [{ role: "user", content: prompt }],
  };
}

test("ordinary tool turns produce one prepared state", async () => {
  await withEnv({
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_MAX_TOOLS: "8",
    XTALPI_PI_TOOLS_DEBUG: undefined,
  }, () => {
    const result = prepareProviderTurn({
      model: MODEL,
      context: context("read package.json", [tool("read", "Read a file")]),
    });

    assert.equal(result.kind, "ready");
    assert.deepEqual([...result.state.names], ["read"]);
    assert.deepEqual(result.state.selectedToolNames, ["read"]);
    assert.equal(result.state.policy.engine, "v2");
    assert.equal(result.state.messages.at(-1)?.role, "user");
  });
});

test("continue-action prompts reuse recent user context for tool selection", async () => {
  await withEnv({
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_MAX_TOOLS: "8",
    XTALPI_PI_TOOLS_DEBUG: undefined,
  }, () => {
    const result = prepareProviderTurn({
      model: MODEL,
      context: {
        systemPrompt: "system base",
        tools: [tool("read", "Read a file"), tool("bash", "Run shell commands")],
        messages: [
          { role: "user", content: "read package.json and verify the version" },
          { role: "assistant", content: "previous result" },
          { role: "user", content: "继续优化" },
        ],
      },
    });

    assert.equal(result.kind, "ready");
    assert.equal(result.state.serializedContext.toolSelectionPromptSource, "recent_user_continuation");
    assert.match(result.state.serializedContext.toolSelectionPromptText, /read package\.json/);
    assert.ok(result.state.names.has("read"));
  });
});

test("vision tasks fail closed before provider execution when no bridge is registered", async () => {
  await withEnv({
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_MAX_TOOLS: "8",
    XTALPI_PI_TOOLS_DEBUG: undefined,
  }, () => {
    const result = prepareProviderTurn({
      model: MODEL,
      context: context("请分析 /tmp/screenshot.png 这张截图", [tool("read", "Read a file")]),
    });

    assert.equal(result.kind, "final");
    assert.match(result.result.text, /vision bridge 当前未 ready/);
    assert.match(result.result.text, /避免把图片路径误交给 read/);
    assert.equal(result.result.usage.totalTokens, 0);
  });
});

for (const { language, prompt } of [
  { language: "Chinese", prompt: "用 browser67 打开 https://example.invalid 并截图" },
  { language: "English", prompt: "open https://example.invalid with browser67" },
]) {
  test(`browser tasks fail closed instead of falling back to bash or the default browser (${language})`, async () => {
    await withEnv({
      XTALPI_PI_TOOLS_ENGINE: "v2",
      XTALPI_PI_TOOLS_MAX_TOOLS: "8",
      XTALPI_PI_TOOLS_DEBUG: undefined,
    }, () => {
      const result = prepareProviderTurn({
        model: MODEL,
        context: context(prompt, [tool("bash", "Run shell commands")]),
      });

      assert.equal(result.kind, "final");
      assert.match(result.result.text, /本轮没有可执行 browser MCP 工具被选中/);
      assert.match(result.result.text, /拒绝继续使用 bash\/open 代替 browser67/);
      assert.equal(result.result.usage.totalTokens, 0);
    });
  });
}
