import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import registerXtalpiPiTools from "../../../extensions/xtalpi-pi-tools/index.ts";

const fixtureFile = fileURLToPath(new URL(
  "../../../extensions/xtalpi-pi-tools/fixtures/replay-cases.json",
  import.meta.url,
));
const replayFixtures = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));

const MODEL = {
  id: "deepseek-v4-pro",
  maxTokens: 32768,
  api: "xtalpi-pi-tools",
  provider: "xtalpi-pi-tools",
  baseUrl: "https://example.invalid/v1",
};

function chatResponse(content) {
  return {
    choices: [{
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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

async function assertProviderReplayFixture(fixture, provider) {
  await withEnv({
    XTALPI_PI_TOOLS_MAX_TOOLS: String(fixture.maxTools ?? 8),
    XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: String(fixture.maxRepairRetries ?? 2),
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: String(fixture.maxTotalRecoveries ?? 4),
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      const index = Math.min(fetchCount, fixture.responses.length - 1);
      fetchCount += 1;
      return new Response(JSON.stringify(chatResponse(fixture.responses[index].content)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const final = await provider.streamSimple(MODEL, fixture.context, {}).result();
      assert.equal(fetchCount, fixture.expect.fetchCount, fixture.name);
      assert.equal(final.stopReason, fixture.expect.stopReason, fixture.name);

      const text = final.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (fixture.expect.leadingTextIncludes) {
        assert.ok(text.includes(fixture.expect.leadingTextIncludes), fixture.name);
      }
      if (fixture.expect.trailingTextIncludes) {
        assert.ok(text.includes(fixture.expect.trailingTextIncludes), fixture.name);
      }

      const toolCalls = final.content.filter((block) => block.type === "toolCall");
      assert.equal(toolCalls.length, fixture.expect.toolCalls?.length ?? 0, fixture.name);
      for (const [index, expected] of (fixture.expect.toolCalls ?? []).entries()) {
        assert.equal(toolCalls[index].name, expected.name, fixture.name);
        assert.deepEqual(toolCalls[index].arguments, expected.arguments ?? {}, fixture.name);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("provider replay fixtures preserve repair and tool-call behavior", async (t) => {
  assert.ok(Array.isArray(replayFixtures.providerReplay));
  assert.ok(replayFixtures.providerReplay.length >= 15);

  await withEnv({
    XTALPI_PI_TOOLS_API_KEY: "test-key",
    XTALPI_PI_TOOLS_ENGINE: "v2",
    XTALPI_PI_TOOLS_PROFILE: "reliability",
    XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "1",
    XTALPI_PI_TOOLS_RETRY_DELAY_MS: "0",
    XTALPI_PI_TOOLS_RETRY_JITTER_MS: "0",
    XTALPI_PI_TOOLS_DEBUG: undefined,
    XTALPI_PI_TOOLS_DEBUG_PATH: undefined,
  }, async () => {
    const provider = registeredProvider();
    for (const fixture of replayFixtures.providerReplay) {
      await t.test(fixture.name, () => assertProviderReplayFixture(fixture, provider));
    }
  });
});
