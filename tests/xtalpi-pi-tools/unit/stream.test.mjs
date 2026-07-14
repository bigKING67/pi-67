import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalAssistantMessageEventStream,
  createLocalAssistantMessageEventStream,
  emitTextBlock,
  emitToolCallBlock,
} from "../../../extensions/xtalpi-pi-tools/stream.ts";

function assistantMessage(stopReason = "stop") {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

test("done events resolve the final result, close iteration, and ignore later writes", async () => {
  const stream = createLocalAssistantMessageEventStream();
  const message = assistantMessage();

  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });

  assert.strictEqual(await stream.result(), message);
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "done"]);

  const exhausted = await stream[Symbol.asyncIterator]().next();
  assert.equal(exhausted.done, true);
});

test("error events close concurrent consumers without leaving pending waiters", async () => {
  const stream = new LocalAssistantMessageEventStream();
  const errorMessage = assistantMessage("error");
  errorMessage.errorMessage = "provider failed";
  const iterator = stream[Symbol.asyncIterator]();
  const terminalEvent = iterator.next();
  const exhausted = iterator.next();

  stream.push({ type: "error", reason: "error", error: errorMessage });

  const delivered = await terminalEvent;
  assert.equal(delivered.done, false);
  assert.equal(delivered.value.type, "error");
  assert.strictEqual(delivered.value.error, errorMessage);
  assert.deepEqual(await exhausted, { value: undefined, done: true });
  assert.strictEqual(await stream.result(), errorMessage);
});

test("explicit end resolves a supplied result and rejects incomplete streams", async () => {
  const completed = new LocalAssistantMessageEventStream();
  const message = assistantMessage();
  const completedIterator = completed[Symbol.asyncIterator]();
  const completedWaiter = completedIterator.next();

  completed.end(message);
  completed.end(assistantMessage("toolUse"));

  assert.strictEqual(await completed.result(), message);
  assert.deepEqual(await completedWaiter, { value: undefined, done: true });

  const incomplete = new LocalAssistantMessageEventStream();
  const incompleteResult = incomplete.result();
  const incompleteWaiter = incomplete[Symbol.asyncIterator]().next();
  incomplete.end();

  await assert.rejects(incompleteResult, /ended without a final message/);
  assert.deepEqual(await incompleteWaiter, { value: undefined, done: true });
});

test("text blocks preserve event order, content indexes, and empty-text semantics", () => {
  const output = assistantMessage();
  const records = [];
  const stream = {
    push(event) {
      records.push({
        event,
        textAtPush: output.content[event.contentIndex]?.text,
      });
    },
  };

  emitTextBlock(stream, output, "hello");
  emitTextBlock(stream, output, "");

  assert.deepEqual(records.map(({ event }) => event.type), [
    "text_start",
    "text_delta",
    "text_end",
    "text_start",
    "text_end",
  ]);
  assert.deepEqual(records.map(({ event }) => event.contentIndex), [0, 0, 0, 1, 1]);
  assert.deepEqual(records.map(({ textAtPush }) => textAtPush), ["", "hello", "hello", "", ""]);
  assert.deepEqual(output.content, [
    { type: "text", text: "hello" },
    { type: "text", text: "" },
  ]);
  assert.strictEqual(records[0].event.partial, output);
  assert.equal(records[1].event.delta, "hello");
  assert.equal(records[2].event.content, "hello");
});

test("tool-call blocks emit one canonical JSON argument delta", () => {
  const output = assistantMessage();
  output.content.push({ type: "text", text: "before" });
  const events = [];
  const stream = { push: (event) => events.push(event) };
  const toolCall = {
    type: "toolCall",
    id: "call_read_1",
    name: "read",
    arguments: { path: "package.json", line: 2 },
  };

  emitToolCallBlock(stream, output, toolCall);

  assert.deepEqual(events.map((event) => event.type), [
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ]);
  assert.deepEqual(events.map((event) => event.contentIndex), [1, 1, 1]);
  assert.equal(events[1].delta, '{"path":"package.json","line":2}');
  assert.strictEqual(events[2].toolCall, toolCall);
  assert.strictEqual(events[0].partial, output);
  assert.strictEqual(output.content[1], toolCall);
});
