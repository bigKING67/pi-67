import assert from "node:assert/strict";

export const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

export const TEST_MODEL = Object.freeze({
  id: "deepseek-v4-pro",
  maxTokens: 32768,
  api: "xtalpi-pi-tools",
  provider: "xtalpi-pi-tools",
  baseUrl: "https://example.invalid/v1",
});

export const READ_TOOL = Object.freeze({
  name: "read",
  description: "Read a local file",
  parameters: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
});

export function simpleTool(name, properties = {}) {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties,
      additionalProperties: false,
    },
  };
}

export function scriptedChat(contents) {
  assert.ok(contents.length > 0, "scriptedChat requires at least one response");
  const calls = [];
  let index = 0;
  return {
    calls,
    callChat: async (input) => {
      calls.push(structuredClone({ messages: input.messages, policy: input.policy }));
      const response = contents[Math.min(index, contents.length - 1)];
      index += 1;
      return {
        content: typeof response === "string" ? response : response.content,
        usage: typeof response === "string" ? { ...ZERO_USAGE } : response.usage ?? { ...ZERO_USAGE },
        responseModel: "deepseek-v4-pro",
      };
    },
  };
}

export function chatCompletionBody(content) {
  return JSON.stringify({
    model: "deepseek-v4-pro",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content },
    }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
}

export async function withRuntimeEnv(overrides, fn) {
  const runtimeNames = new Set([
    ...Object.keys(process.env).filter((name) => name.startsWith("XTALPI_PI_TOOLS_")),
    ...Object.keys(overrides),
  ]);
  const previous = new Map([...runtimeNames].map((name) => [name, process.env[name]]));
  try {
    for (const name of runtimeNames) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[name] = String(value);
    }
    return await fn();
  } finally {
    for (const name of runtimeNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function withFetch(fetchImplementation, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}
