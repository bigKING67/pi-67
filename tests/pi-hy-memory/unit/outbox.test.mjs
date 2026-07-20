import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHyMemoryPaths } from "../../../extensions/pi-hy-memory/config.ts";
import { countOutbox, queueCapture, stableCaptureRequestId } from "../../../extensions/pi-hy-memory/outbox.ts";

test("outbox writes atomically and deduplicates stable settled-turn IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-outbox-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const input = {
      userId: "user-fixture",
      agentId: "pi-67",
      sessionId: "session-fixture",
      leafId: "leaf-fixture",
      messages: [
        { role: "user", content: "Remember this" },
        { role: "assistant", content: "Noted" },
      ],
    };
    const expected = stableCaptureRequestId(input);
    const first = queueCapture(input, paths);
    const second = queueCapture(input, paths);
    assert.equal(first.requestId, expected);
    assert.equal(first.queued, true);
    assert.equal(second.queued, false);
    assert.deepEqual(countOutbox(paths), { pending: 1, processing: 0, deadLetter: 0 });
    assert.equal(fs.readdirSync(paths.pendingDir).some((name) => name.endsWith(".tmp")), false);
    const job = JSON.parse(fs.readFileSync(first.file, "utf8"));
    assert.equal(job.requestId, expected);
    assert.equal(job.attempts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
