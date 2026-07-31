import assert from "node:assert/strict";
import test from "node:test";
import { createPiHyMemory } from "../../../extensions/pi-hy-memory/index.ts";
import { defaultMemoryConfig } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

test("Pi lifecycle gates recall by config and injects successful recall as untrusted context", async () => {
  let config = { ...defaultMemoryConfig("lifecycle-user"), enabled: false };
  let ensureCalls = 0;
  const harness = createLifecycleHarness({
    readConfig: () => config,
    ensureHyMemoryService: async () => {
      ensureCalls += 1;
      return recallClient("remembered fixture");
    },
  });

  await harness.emit("session_start", { type: "session_start" });
  assert.equal(ensureCalls, 0);
  assert.equal(await harness.emit("before_agent_start", beforeAgentStart("disabled query")), undefined);
  assert.equal(ensureCalls, 0);

  config = { ...config, enabled: true };
  await harness.emit("session_start", { type: "session_start" });
  assert.equal(ensureCalls, 1);
  const recalled = await harness.emit("before_agent_start", beforeAgentStart("enabled query"));
  assert.equal(ensureCalls, 2);
  assert.match(recalled.systemPrompt, /\[Hy-Memory reference context\]/);
  assert.match(recalled.systemPrompt, /remembered fixture/);
  assert.deepEqual(harness.notifications, []);
  await harness.emit("session_shutdown", { type: "session_shutdown" });
});

test("automatic recall warns once, enters a bounded cooldown, and recovers", async () => {
  let now = 1_000;
  let searchCalls = 0;
  const responses = [
    new Error("Hy-Memory request timed out after 5000ms"),
    new Error("Hy-Memory request timed out after 5000ms"),
    "recovered memory",
    new Error("Hy-Memory request timed out after 5000ms"),
    "second recovery",
  ];
  const harness = createLifecycleHarness({
    now: () => now,
    ensureHyMemoryService: async () => ({
      async search() {
        const response = responses[searchCalls];
        searchCalls += 1;
        if (response instanceof Error) throw response;
        return recallPayload(response);
      },
    }),
  });

  await harness.emit("session_start", { type: "session_start" });
  assert.equal(await harness.emit("before_agent_start", beforeAgentStart("private first prompt")), undefined);
  assert.equal(await harness.emit("before_agent_start", beforeAgentStart("private second prompt")), undefined);
  assert.equal(searchCalls, 2);
  assert.equal(await harness.emit("before_agent_start", beforeAgentStart("cooldown prompt")), undefined);
  assert.equal(searchCalls, 2, "recall should not wait on the service during cooldown");

  const recallWarnings = harness.notifications.filter((item) => item.level === "warning");
  assert.equal(recallWarnings.length, 1);
  assert.match(recallWarnings[0].message, /temporarily unavailable \(timeout\)/);
  assert.doesNotMatch(recallWarnings[0].message, /private first prompt|private second prompt/);

  now += 30_001;
  const recovered = await harness.emit("before_agent_start", beforeAgentStart("retry prompt"));
  assert.match(recovered.systemPrompt, /recovered memory/);
  assert.equal(searchCalls, 3);

  assert.equal(await harness.emit("before_agent_start", beforeAgentStart("one failure after recovery")), undefined);
  const secondRecovery = await harness.emit("before_agent_start", beforeAgentStart("no immediate cooldown"));
  assert.match(secondRecovery.systemPrompt, /second recovery/);
  assert.equal(searchCalls, 5, "a successful recall should reset the consecutive failure counter");
  assert.equal(harness.notifications.filter((item) => item.level === "warning").length, 1);
});

test("session start failure reports only a sanitized service error kind", async () => {
  const harness = createLifecycleHarness({
    ensureHyMemoryService: async () => {
      throw new Error("spawn /private/runtime/path ENOENT with fixture-secret-value");
    },
  });

  await harness.emit("session_start", { type: "session_start" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /temporarily unavailable \(service\)/);
  assert.doesNotMatch(harness.notifications[0].message, /private\/runtime|fixture-secret-value|ENOENT/);
});

test("settled capture excludes failed assistants, deduplicates settle events, and warns once on queue failure", async () => {
  const queued = [];
  let queueShouldFail = false;
  const harness = createLifecycleHarness({
    queueCapture(job) {
      if (queueShouldFail) throw new Error("fixture queue full");
      queued.push(job);
    },
  });
  await harness.emit("session_start", { type: "session_start" });

  await harness.emit("agent_end", agentEnd("failed answer", "error"));
  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(queued.length, 0);

  await harness.emit("agent_end", agentEnd("settled answer", "stop"));
  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].messages, [
    { role: "user", content: "remember this turn" },
    { role: "assistant", content: "settled answer" },
  ]);
  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(queued.length, 1, "duplicate agent_settled must not queue the same candidate twice");

  queueShouldFail = true;
  for (const answer of ["queue failure one", "queue failure two"]) {
    await harness.emit("agent_end", agentEnd(answer, "stop"));
    await harness.emit("agent_settled", { type: "agent_settled" });
  }
  const queueWarnings = harness.notifications.filter((item) => item.message.includes("could not queue"));
  assert.equal(queueWarnings.length, 1);
  assert.match(queueWarnings[0].message, /fixture queue full/);
});

function createLifecycleHarness(overrides = {}) {
  const handlers = new Map();
  const notifications = [];
  const config = defaultMemoryConfig("lifecycle-user");
  const dependencies = {
    readConfig: () => config,
    ensureHyMemoryService: async () => recallClient("fixture memory"),
    queueCapture: () => {},
    now: Date.now,
    ...overrides,
  };
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name, handler) {
      assert.equal(handlers.has(name), false, `duplicate handler for ${name}`);
      handlers.set(name, handler);
    },
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => "session-fixture",
      getLeafId: () => "leaf-fixture",
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
  createPiHyMemory(dependencies)(pi);
  return {
    notifications,
    async emit(name, event) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing lifecycle handler: ${name}`);
      return await handler(event, ctx);
    },
  };
}

function recallClient(content) {
  return { search: async () => recallPayload(content) };
}

function recallPayload(content) {
  return { memories: { normal: [{ content, score: 0.9 }] } };
}

function beforeAgentStart(prompt) {
  return { type: "before_agent_start", prompt, systemPrompt: "base system prompt", systemPromptOptions: {} };
}

function agentEnd(assistantText, stopReason) {
  return {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "remember this turn" }] },
      { role: "assistant", content: [{ type: "text", text: assistantText }], stopReason },
    ],
  };
}
