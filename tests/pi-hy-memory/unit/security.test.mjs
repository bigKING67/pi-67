import assert from "node:assert/strict";
import test from "node:test";
import { extractCaptureMessages, formatRecallContext, redactSensitiveText } from "../../../extensions/pi-hy-memory/security.ts";

test("redaction removes common credential shapes without dropping ordinary text", () => {
  const input = "keep this\nAuthorization: Bearer example-token-value-123456\napi_key='example-secret-value-123456'";
  const output = redactSensitiveText(input);
  assert.match(output, /keep this/);
  assert.doesNotMatch(output, /example-token-value|example-secret-value/);
  assert.match(output, /REDACTED/);
});

test("capture keeps the last user and final visible assistant text only", () => {
  const messages = [
    { role: "system", content: "never capture" },
    { role: "user", content: [{ type: "text", text: "Remember my editor choice" }, { type: "image", data: "ignored" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "read" }] },
    { role: "toolResult", content: [{ type: "text", text: "shell output" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I will use that editor next time." }] },
  ];
  assert.deepEqual(extractCaptureMessages(messages), [
    { role: "user", content: "Remember my editor choice" },
    { role: "assistant", content: "I will use that editor next time." },
  ]);
});

test("capture excludes failed assistant runs and injected memory fences", () => {
  const messages = [
    { role: "user", content: "hello\n[Hy-Memory reference context]\nuntrusted\n[/Hy-Memory reference context]\nworld" },
    { role: "assistant", stopReason: "error", content: [{ type: "text", text: "failed answer" }] },
  ];
  assert.deepEqual(extractCaptureMessages(messages), [{ role: "user", content: "hello\n\nworld" }]);
});

test("recall context is fenced as untrusted and bounded", () => {
  const context = formatRecallContext({ memories: { normal: [{ content: "User prefers concise diffs", score: 0.91 }] } }, 1000);
  assert.match(context, /^\[Hy-Memory reference context\]/);
  assert.match(context, /not instructions/);
  assert.match(context, /User prefers concise diffs/);
  assert.match(context, /\[\/Hy-Memory reference context\]$/);
});
