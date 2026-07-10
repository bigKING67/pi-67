import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  debugLog,
  debugQueueSnapshot,
  flushDebugLogs,
} from "../../../extensions/xtalpi-pi-tools/diagnostics.ts";
import { withRuntimeEnv } from "../test-support.mjs";

test("diagnostics queue is bounded, reports drops, and drains on flush", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-debug-queue."));
  const file = path.join(dir, "debug.jsonl");
  try {
    await withRuntimeEnv({
      XTALPI_PI_TOOLS_DEBUG: "1",
      XTALPI_PI_TOOLS_DEBUG_PATH: file,
    }, async () => {
      const droppedBefore = debugQueueSnapshot().dropped;
      for (let index = 0; index < 600; index += 1) {
        debugLog("queue.test", { index });
      }
      const queued = debugQueueSnapshot();
      assert.ok(queued.queued <= queued.limit);
      assert.ok(queued.dropped > droppedBefore);
      await flushDebugLogs();
      assert.equal(debugQueueSnapshot().queued, 0);
    });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.ok(lines.length > 0 && lines.length <= 512);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostics batches multiple paths and preserves redaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-debug-paths."));
  const first = path.join(dir, "a", "debug.jsonl");
  const second = path.join(dir, "b", "debug.jsonl");
  try {
    await withRuntimeEnv({ XTALPI_PI_TOOLS_DEBUG: "1", XTALPI_PI_TOOLS_DEBUG_PATH: first }, async () => {
      debugLog("path.first", { authorization: "Bearer top-secret-token" });
      process.env.XTALPI_PI_TOOLS_DEBUG_PATH = second;
      debugLog("path.second", { password: "super-secret-password" });
      await flushDebugLogs();
    });
    const firstText = fs.readFileSync(first, "utf8");
    const secondText = fs.readFileSync(second, "utf8");
    assert.match(firstText, /Bearer \[REDACTED\]/);
    assert.ok(!firstText.includes("top-secret-token"));
    assert.match(secondText, /password[^\n]*\[REDACTED\]/i);
    assert.ok(!secondText.includes("super-secret-password"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostics write failures never escape into provider flow", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-debug-failure."));
  try {
    await withRuntimeEnv({
      XTALPI_PI_TOOLS_DEBUG: "1",
      XTALPI_PI_TOOLS_DEBUG_PATH: dir,
    }, async () => {
      debugLog("write.failure", { ok: true });
      await assert.doesNotReject(() => flushDebugLogs());
      assert.equal(debugQueueSnapshot().queued, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("beforeExit performs a minimum best-effort flush", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xtalpi-debug-exit."));
  const file = path.join(dir, "debug.jsonl");
  const diagnosticsUrl = new URL("../../../extensions/xtalpi-pi-tools/diagnostics.ts", import.meta.url).href;
  try {
    const script = [
      `process.env.XTALPI_PI_TOOLS_DEBUG = "1";`,
      `process.env.XTALPI_PI_TOOLS_DEBUG_PATH = ${JSON.stringify(file)};`,
      `const diagnostics = await import(${JSON.stringify(diagnosticsUrl)});`,
      `diagnostics.debugLog("exit.flush", { marker: "EXIT_FLUSH_OK" });`,
    ].join("\n");
    const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(child.signal, null);
    assert.match(fs.readFileSync(file, "utf8"), /EXIT_FLUSH_OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
