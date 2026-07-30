import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHyMemoryPaths } from "../../../extensions/pi-hy-memory/config.ts";
import {
  countOutbox,
  inspectOutbox,
  pruneDeadLetters,
  queueCapture,
  stableCaptureRequestId,
} from "../../../extensions/pi-hy-memory/outbox.ts";

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

test("outbox admission exposes and enforces active job capacity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-capacity-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const policy = {
      maxActiveJobs: 1,
      maxActiveBytes: 1024 * 1024,
      maxDeadLetterJobs: 10,
      maxDeadLetterBytes: 1024 * 1024,
      deadLetterRetentionMs: 60_000,
    };
    const base = {
      userId: "user-fixture",
      agentId: "pi-67",
      sessionId: "session-fixture",
      messages: [{ role: "user", content: "one" }],
    };
    queueCapture({ ...base, leafId: "leaf-one" }, paths, policy);
    assert.throws(
      () => queueCapture({ ...base, leafId: "leaf-two" }, paths, policy),
      /outbox capacity exceeded/,
    );
    const status = inspectOutbox(paths, policy);
    assert.equal(status.pending, 1);
    assert.equal(status.saturated, true);
    assert.deepEqual(status.limits, policy);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dead-letter retention removes expired and over-count entries deterministically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-retention-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    fs.mkdirSync(paths.deadLetterDir, { recursive: true });
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const write = (name, updatedAt) => fs.writeFileSync(
      path.join(paths.deadLetterDir, `${name}.json`),
      `${JSON.stringify({ schema: "pi67-hy-memory-outbox/v1", requestId: name, updatedAt })}\n`,
    );
    write("expired", "2026-07-29T23:00:00.000Z");
    write("older", "2026-07-29T23:59:58.000Z");
    write("newer", "2026-07-29T23:59:59.000Z");
    const removed = pruneDeadLetters(paths, {
      maxActiveJobs: 10,
      maxActiveBytes: 1024 * 1024,
      maxDeadLetterJobs: 1,
      maxDeadLetterBytes: 1024 * 1024,
      deadLetterRetentionMs: 10_000,
    }, now);
    assert.equal(removed, 2);
    assert.deepEqual(fs.readdirSync(paths.deadLetterDir), ["newer.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("outbox admission refuses an active lock and recovers only a stale empty lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-admission-lock-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    fs.mkdirSync(paths.outboxDir, { recursive: true });
    fs.mkdirSync(paths.outboxAdmissionLockDir);
    const input = {
      userId: "user-fixture",
      agentId: "pi-67",
      sessionId: "session-fixture",
      leafId: "leaf-fixture",
      messages: [{ role: "user", content: "fixture" }],
    };
    assert.throws(() => queueCapture(input, paths), /outbox admission is busy/);
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(paths.outboxAdmissionLockDir, stale, stale);
    assert.equal(queueCapture(input, paths).queued, true);
    assert.equal(fs.existsSync(paths.outboxAdmissionLockDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
