import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flushDebugLogs } from "../../../extensions/xtalpi-pi-tools/diagnostics.ts";
import { runProviderTurn } from "../../../extensions/xtalpi-pi-tools/provider-turn.ts";
import {
  READ_TOOL,
  TEST_MODEL,
  scriptedChat,
  simpleTool,
  withRuntimeEnv,
} from "../test-support.mjs";

const RECOVERY_ENV = Object.freeze({
  XTALPI_PI_TOOLS_ENGINE: "v2",
  XTALPI_PI_TOOLS_MAX_EMPTY_RECOVERIES: "1",
  XTALPI_PI_TOOLS_MAX_FORMAT_RECOVERIES: "1",
  XTALPI_PI_TOOLS_MAX_FINAL_RECOVERIES: "1",
  XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "2",
  XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "2",
});

function basicContext(prompt, tools = []) {
  return {
    systemPrompt: "system base",
    tools,
    messages: [{ role: "user", content: prompt }],
  };
}

function visionContext() {
  return basicContext("请分析 /tmp/screenshot.png 这张截图", [
    simpleTool("vision_read", {
      image: { type: "string" },
      prompt: { type: "string" },
    }),
  ]);
}

test("empty responses recover once and then stop deterministically at the configured boundary", async (t) => {
  await t.test("one empty response is repaired", async () => {
    await withRuntimeEnv(RECOVERY_ENV, async () => {
      const chat = scriptedChat([
        "",
        '{"kind":"final","text":"recovered after empty response"}',
      ]);
      const result = await runProviderTurn({
        model: TEST_MODEL,
        context: basicContext("hello"),
        callChat: chat.callChat,
      });

      assert.equal(result.kind, "final");
      assert.equal(result.text, "recovered after empty response");
      assert.equal(chat.calls.length, 2);
      assert.match(chat.calls[1].messages.at(-1).content, /xtalpi-pi-tools-empty-response-repair/);
    });
  });

  await t.test("zero empty-response budget fails with a non-empty local result", async () => {
    await withRuntimeEnv({
      ...RECOVERY_ENV,
      XTALPI_PI_TOOLS_MAX_EMPTY_RECOVERIES: "0",
      XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "0",
    }, async () => {
      const chat = scriptedChat([""]);
      const result = await runProviderTurn({
        model: TEST_MODEL,
        context: basicContext("hello"),
        callChat: chat.callChat,
      });

      assert.equal(result.kind, "final");
      assert.match(result.text, /收到连续空响应/);
      assert.match(result.text, /避免卡死/);
      assert.equal(chat.calls.length, 1);
    });
  });
});

test("vision inability recovery works for parse-error and canonical-final responses", async (t) => {
  const cases = [
    {
      name: "plain parse-error response",
      response: "I cannot inspect this image.",
    },
    {
      name: "canonical final response",
      response: '{"kind":"final","text":"I cannot inspect this image."}',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withRuntimeEnv(RECOVERY_ENV, async () => {
        const chat = scriptedChat([
          fixture.response,
          '{"kind":"tool_call","name":"vision_read","arguments":{"image":"/tmp/screenshot.png","prompt":"分析截图"}}',
        ]);
        const result = await runProviderTurn({
          model: TEST_MODEL,
          context: visionContext(),
          callChat: chat.callChat,
        });

        assert.equal(result.kind, "tool_call");
        assert.equal(result.toolCall.name, "vision_read");
        assert.equal(chat.calls.length, 2);
        assert.match(chat.calls[1].messages.at(-1).content, /xtalpi-pi-tools-vision-bridge-tool-call-repair/);
      });
    });
  }
});

test("vision inability exhaustion returns an actionable local result for both parser paths", async (t) => {
  for (const response of [
    "I cannot inspect this image.",
    '{"kind":"final","text":"I cannot inspect this image."}',
  ]) {
    await t.test(response.startsWith("{") ? "canonical final" : "plain response", async () => {
      await withRuntimeEnv({
        ...RECOVERY_ENV,
        XTALPI_PI_TOOLS_MAX_FINAL_RECOVERIES: "0",
        XTALPI_PI_TOOLS_MAX_FORMAT_RECOVERIES: "0",
        XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "0",
        XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "0",
      }, async () => {
        const chat = scriptedChat([response]);
        const result = await runProviderTurn({
          model: TEST_MODEL,
          context: visionContext(),
          callChat: chat.callChat,
        });

        assert.equal(result.kind, "final");
        assert.match(result.text, /自动修复预算已用尽/);
        assert.match(result.text, /pi-67 doctor/);
        assert.equal(chat.calls.length, 1);
      });
    });
  }
});

test("canonical premature finals recover into concrete progress", async (t) => {
  const cases = [
    {
      name: "weak final",
      prompt: "continue",
      tools: [],
      first: '{"kind":"final","text":"OK"}',
      second: '{"kind":"final","text":"Concrete final answer after continuing."}',
      expectedCode: "weak_final",
      expectedKind: "final",
    },
    {
      name: "intent without tool call",
      prompt: "Read package.json",
      tools: [READ_TOOL],
      first: '{"kind":"final","text":"I need to read package.json first."}',
      second: '{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}',
      expectedCode: "intent_to_tool_no_call",
      expectedKind: "tool_call",
    },
    {
      name: "tool-call-like JSON embedded in final text",
      prompt: "继续呀",
      tools: [READ_TOOL],
      first: '{"kind":"final","text":"I will call tool: {\\"name\\":\\"read\\",\\"arguments\\":{\\"path\\":\\"package.json\\"}}"}',
      second: '{"kind":"tool_call","name":"read","arguments":{"path":"package.json"}}',
      expectedCode: "tool_call_like_final",
      expectedKind: "tool_call",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withRuntimeEnv(RECOVERY_ENV, async () => {
        const chat = scriptedChat([fixture.first, fixture.second]);
        const result = await runProviderTurn({
          model: TEST_MODEL,
          context: basicContext(fixture.prompt, fixture.tools),
          callChat: chat.callChat,
        });

        assert.equal(result.kind, fixture.expectedKind);
        assert.equal(chat.calls.length, 2);
        assert.match(chat.calls[1].messages.at(-1).content, new RegExp(fixture.expectedCode));
      });
    });
  }
});

test("malformed Windows bash JSON recovers before shell semantics consume the remaining format budget", async () => {
  await withRuntimeEnv(RECOVERY_ENV, async () => {
    const malformed = String.raw`{"kind":"tool_call","name":"bash","arguments":{"command":"ls -la "C:\Users\Groland\.agents\skills\investment-checklist\scripts\" 2>/dev/null || echo "scripts directory not found"","timeout":5}}`;
    const chat = scriptedChat([
      malformed,
      JSON.stringify({
        kind: "tool_call",
        name: "bash",
        arguments: {
          command: String.raw`ls -la "C:\Users\Groland\.agents\skills\investment-checklist\scripts"`,
          timeout: 5,
        },
      }),
      JSON.stringify({
        kind: "tool_call",
        name: "bash",
        arguments: {
          command: 'ls -la "$HOME/.agents/skills/investment-checklist/scripts"',
          timeout: 5,
        },
      }),
    ]);
    const result = await runProviderTurn({
      model: TEST_MODEL,
      context: basicContext("inspect the investment checklist scripts directory", [
        simpleTool("bash", {
          command: { type: "string" },
          timeout: { type: "number" },
        }),
      ]),
      callChat: chat.callChat,
    });

    assert.equal(result.kind, "tool_call");
    assert.equal(result.toolCall.name, "bash");
    assert.equal(result.toolCall.arguments.command, 'ls -la "$HOME/.agents/skills/investment-checklist/scripts"');
    assert.equal(chat.calls.length, 3);
    assert.match(chat.calls[1].messages.at(-1).content, /xtalpi-pi-tools-malformed-windows-bash-json-repair/);
    assert.match(chat.calls[2].messages.at(-1).content, /xtalpi-pi-tools-shell-command-mismatch-repair/);
  });
});

test("canonical final exhaustion distinguishes Plan fallback from non-Plan rejection", async () => {
  await withRuntimeEnv({
    ...RECOVERY_ENV,
    XTALPI_PI_TOOLS_MAX_FINAL_RECOVERIES: "0",
    XTALPI_PI_TOOLS_MAX_REPAIR_RECOVERIES_TOTAL: "0",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "0",
  }, async () => {
    const planChat = scriptedChat([
      '{"kind":"final","text":"I will inspect the ETL parser next."}',
    ]);
    const planResult = await runProviderTurn({
      model: TEST_MODEL,
      context: {
        systemPrompt: "Plan mode: planning\nProduce a <proposed_plan> block.",
        tools: [READ_TOOL],
        messages: [{ role: "user", content: "先给解决计划" }],
      },
      callChat: planChat.callChat,
    });
    assert.equal(planResult.kind, "final");
    assert.match(planResult.text, /Local fallback note/);
    assert.match(planResult.text, /<proposed_plan>/);

    const rejectChat = scriptedChat([
      '{"kind":"final","text":"I will inspect the file next."}',
    ]);
    const rejectResult = await runProviderTurn({
      model: TEST_MODEL,
      context: basicContext("继续呀", [READ_TOOL]),
      callChat: rejectChat.callChat,
    });
    assert.equal(rejectResult.kind, "final");
    assert.match(rejectResult.text, /模型返回疑似未完成的最终回答/);
    assert.match(rejectResult.text, /instead of calling a tool or producing concrete output/);
  });
});

test("accepted Plan continuation is not mistaken for active Plan mode", async () => {
  await withRuntimeEnv(RECOVERY_ENV, async () => {
    const chat = scriptedChat([
      '{"kind":"final","text":"Proceeding with the accepted plan now."}',
    ]);
    const result = await runProviderTurn({
      model: TEST_MODEL,
      context: {
        systemPrompt: "system base",
        tools: [READ_TOOL],
        messages: [{
          role: "user",
          content:
            "Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n" +
            "1. Inspect relevant state after approval.",
        }],
      },
      callChat: chat.callChat,
    });

    assert.equal(result.kind, "final");
    assert.equal(result.text, "Proceeding with the accepted plan now.");
    assert.equal(chat.calls.length, 1);
  });
});

test("argument-validation warnings remain observable without leaking unsafe regex patterns", async () => {
  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-provider-warning."));
  const debugFile = path.join(debugDir, "debug.jsonl");
  try {
    await withRuntimeEnv({
      ...RECOVERY_ENV,
      XTALPI_PI_TOOLS_DEBUG: "1",
      XTALPI_PI_TOOLS_DEBUG_PATH: debugFile,
    }, async () => {
      const unsafePatternTool = {
        name: "unsafe_pattern",
        description: "Exercise bounded regex validation telemetry",
        parameters: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string", pattern: "^(a+)+$" } },
        },
      };
      const chat = scriptedChat([
        `{"kind":"tool_call","name":"unsafe_pattern","arguments":{"value":"${"a".repeat(2048)}!"}}`,
      ]);
      const result = await runProviderTurn({
        model: TEST_MODEL,
        context: basicContext("call unsafe_pattern once", [unsafePatternTool]),
        callChat: chat.callChat,
      });
      assert.equal(result.kind, "tool_call");
      await flushDebugLogs();
    });

    const events = fs.readFileSync(debugFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const warningEvent = events.find((event) => event.event === "tool_call");
    assert.ok(warningEvent);
    assert.equal(warningEvent.argument_validation_warning_count, 1);
    assert.deepEqual(warningEvent.argument_validation_warning_codes, ["pattern_nested_quantifier"]);
    assert.equal(warningEvent.data.argumentValidationWarnings[0].path, "arguments.value");
    assert.ok(!JSON.stringify(warningEvent).includes("^(a+)+$"));
  } finally {
    fs.rmSync(debugDir, { recursive: true, force: true });
  }
});
