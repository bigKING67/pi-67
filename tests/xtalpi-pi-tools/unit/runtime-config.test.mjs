import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  XTALPI_API_KEY_REFERENCE,
  buildChatCompletionPayload,
  endpointFor,
  isPlaceholderKey,
  loadRuntimeConfig,
  normalizeBaseUrl,
  resolveMaxOutputTokens,
  resolveProviderRuntimePolicy,
  resolveRequestTimeoutMs,
} from "../../../extensions/xtalpi-pi-tools/runtime-config.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
} from "../../../extensions/xtalpi-pi-tools/protocol.ts";

async function withIsolatedEnv(overrides, callback) {
  const names = new Set([
    ...Object.keys(process.env).filter((name) => name.startsWith("XTALPI_PI_TOOLS_")),
    "XTALPI_API_KEY",
    "XTALPI_BASE_URL",
    "PI_AGENT_DIR",
    "HOME",
    ...Object.keys(overrides),
  ]);
  const previous = Object.fromEntries([...names].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function tempRuntimeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-runtime-config."));
  const agentDir = path.join(root, "agent");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, agentDir, homeDir };
}

function writeModels(agentDir, value) {
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(value));
}

test("runtime config honors direct env, legacy env, and file precedence", async () => {
  const tree = tempRuntimeTree();
  try {
    writeModels(tree.agentDir, {
      providers: {
        "xtalpi-pi-tools": {
          baseUrl: "https://file.example.invalid/v1",
          apiKey: "file-test-key",
          models: [
            {
              id: "custom-pro",
              contextWindow: 131072,
              maxTokens: 16384,
              cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            },
            "invalid-model-entry",
          ],
        },
      },
    });

    await withIsolatedEnv({
      PI_AGENT_DIR: tree.agentDir,
      HOME: tree.homeDir,
      XTALPI_PI_TOOLS_BASE_URL: "https://direct.example.invalid/v1",
      XTALPI_BASE_URL: "https://legacy.example.invalid/v1",
      XTALPI_PI_TOOLS_API_KEY: "direct-test-key",
      XTALPI_API_KEY: "legacy-test-key",
    }, () => {
      assert.deepEqual(loadRuntimeConfig(), {
        baseUrl: "https://direct.example.invalid/v1",
        apiKey: "direct-test-key",
        models: [{
          id: "custom-pro",
          name: "custom-pro",
          api: "xtalpi-pi-tools",
          reasoning: false,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 16384,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        }],
      });

      delete process.env.XTALPI_PI_TOOLS_BASE_URL;
      delete process.env.XTALPI_PI_TOOLS_API_KEY;
      assert.equal(loadRuntimeConfig().baseUrl, "https://legacy.example.invalid/v1");
      assert.equal(loadRuntimeConfig().apiKey, "legacy-test-key");

      delete process.env.XTALPI_BASE_URL;
      delete process.env.XTALPI_API_KEY;
      assert.equal(loadRuntimeConfig().baseUrl, "https://file.example.invalid/v1");
      assert.equal(loadRuntimeConfig().apiKey, "file-test-key");
    });
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test("placeholder and deferred file keys never become runtime credentials", async () => {
  const tree = tempRuntimeTree();
  try {
    await withIsolatedEnv({ PI_AGENT_DIR: tree.agentDir, HOME: tree.homeDir }, () => {
      for (const apiKey of ["YOUR_XTALPI_API_KEY", "$XTALPI_PI_TOOLS_API_KEY", "!secret-command"]) {
        writeModels(tree.agentDir, {
          providers: {
            "xtalpi-pi-tools": { apiKey, models: [] },
          },
        });
        const config = loadRuntimeConfig();
        assert.equal(config.baseUrl, DEFAULT_BASE_URL);
        assert.equal(config.apiKey, "");
        assert.equal(config.models.length, 4);
      }
    });

    assert.equal(isPlaceholderKey(undefined), true);
    assert.equal(isPlaceholderKey("REPLACE_ME"), true);
    assert.equal(isPlaceholderKey("changeme"), true);
    assert.equal(isPlaceholderKey("realistic-test-key"), false);
    assert.equal(XTALPI_API_KEY_REFERENCE, "$XTALPI_PI_TOOLS_API_KEY");
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test("invalid primary models JSON falls back to the isolated HOME config", async () => {
  const tree = tempRuntimeTree();
  const homeAgentDir = path.join(tree.homeDir, ".pi", "agent");
  fs.mkdirSync(homeAgentDir, { recursive: true });
  fs.writeFileSync(path.join(tree.agentDir, "models.json"), "{invalid json");
  writeModels(homeAgentDir, {
    providers: {
      "xtalpi-pi-tools": {
        baseUrl: "https://home.example.invalid/v1",
        apiKey: "home-test-key",
      },
    },
  });

  try {
    await withIsolatedEnv({ PI_AGENT_DIR: tree.agentDir, HOME: tree.homeDir }, () => {
      const config = loadRuntimeConfig();
      assert.equal(config.baseUrl, "https://home.example.invalid/v1");
      assert.equal(config.apiKey, "home-test-key");
    });
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test("URL, timeout, and output-token resolution are bounded and deterministic", async () => {
  assert.equal(normalizeBaseUrl("https://example.invalid/v1///"), "https://example.invalid/v1");
  assert.equal(
    endpointFor(
      { baseUrl: "https://model.example.invalid/api/" },
      { baseUrl: "https://runtime.example.invalid/api/" },
    ),
    "https://model.example.invalid/api/chat/completions",
  );
  assert.equal(
    endpointFor({}, { baseUrl: "https://runtime.example.invalid/api/" }),
    "https://runtime.example.invalid/api/chat/completions",
  );
  assert.equal(endpointFor({}), `${DEFAULT_BASE_URL}/chat/completions`);

  await withIsolatedEnv({}, () => {
    assert.equal(resolveRequestTimeoutMs({ timeoutMs: 300000.9 }), 300000);
    assert.equal(resolveRequestTimeoutMs({ timeoutMs: 0 }), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveRequestTimeoutMs({ timeoutMs: Number.NaN }), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveRequestTimeoutMs(), DEFAULT_TIMEOUT_MS);

    assert.equal(resolveMaxOutputTokens({ maxTokens: 32768 }, { maxTokens: 4096.9 }), 4096);
    assert.equal(resolveMaxOutputTokens({ maxTokens: 2048 }, { maxTokens: 4096 }), 2048);
    assert.equal(resolveMaxOutputTokens({ maxTokens: 32768 }, {}), DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(resolveMaxOutputTokens({ maxTokens: 1024 }, { maxTokens: 4096 }, { maxOutputTokens: 2048 }), 1024);

    process.env.XTALPI_PI_TOOLS_TIMEOUT_MS = "120000";
    process.env.XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS = "1024";
    assert.equal(resolveRequestTimeoutMs({ timeoutMs: 300000 }), 120000);
    assert.equal(resolveMaxOutputTokens({ maxTokens: 32768 }, { maxTokens: 4096 }), 1024);

    process.env.XTALPI_PI_TOOLS_TIMEOUT_MS = "invalid";
    process.env.XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS = "invalid";
    assert.equal(resolveRequestTimeoutMs({ timeoutMs: 300000 }), 300000);
    assert.equal(resolveMaxOutputTokens({ maxTokens: 32768 }, { maxTokens: 4096 }), 4096);
  });
});

test("runtime policy configuration failures retain the offending variable", async () => {
  await withIsolatedEnv({ XTALPI_PI_TOOLS_REQUEST_ATTEMPTS: "0" }, () => {
    assert.throws(
      () => resolveProviderRuntimePolicy(),
      (error) => error?.code === "configuration_invalid" &&
        error?.category === "configuration" &&
        error?.details?.configurationVariable === "XTALPI_PI_TOOLS_REQUEST_ATTEMPTS",
    );
  });

  await withIsolatedEnv({}, () => {
    const policy = resolveProviderRuntimePolicy({ timeoutMs: 12000, maxTokens: 2048, temperature: 0.4 });
    assert.equal(policy.perAttemptTimeoutMs, 12000);
    assert.equal(policy.maxOutputTokens, 2048);
    assert.equal(policy.temperature, 0.4);
  });
});

test("chat completion payloads stay local-action-only and policy bounded", async () => {
  await withIsolatedEnv({}, () => {
    const messages = [{ role: "user", content: "hello" }];
    const payload = buildChatCompletionPayload(
      { id: "deepseek-v4-pro", maxTokens: 2048 },
      messages,
      { maxTokens: 4096, temperature: 0.2 },
    );
    assert.deepEqual(payload, {
      model: "deepseek-v4-pro",
      messages,
      stream: false,
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const policyPayload = buildChatCompletionPayload(
      { id: "deepseek-v4-pro", maxTokens: 32768 },
      messages,
      { maxTokens: 4096, temperature: 0.8 },
      { maxOutputTokens: 1024, temperature: 0.1 },
    );
    assert.equal(policyPayload.max_tokens, 1024);
    assert.equal(policyPayload.temperature, 0.1);

    for (const field of ["tools", "tool_choice", "parallel_tool_calls", "thinking", "reasoning_effort"]) {
      assert.equal(Object.hasOwn(policyPayload, field), false, field);
    }
  });
});
