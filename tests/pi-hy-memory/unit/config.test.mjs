import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig, resolveHyMemoryPaths, validateConfig } from "../../../extensions/pi-hy-memory/config.ts";
import { defaultMemoryConfig } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

test("canonical config keeps BGE-M3 request dimensions null and vector dimensions 1024", () => {
  const config = defaultMemoryConfig("user-fixture");
  validateConfig(config);
  assert.equal(config.embedder.requestDimensions, null);
  assert.equal(config.embedder.vectorDimensions, 1024);
});

test("config validation rejects accidental BGE-M3 dimensions request parameters", () => {
  const config = defaultMemoryConfig("user-fixture");
  config.embedder.requestDimensions = 1024;
  assert.throws(() => validateConfig(config), /BGE-M3 embedding contract/);
});

test("config loader reads only the private pi67 Hy-Memory root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-config-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(paths.configFile, `${JSON.stringify(defaultMemoryConfig("user-fixture"))}\n`, { mode: 0o600 });
    assert.equal(readConfig(paths)?.userId, "user-fixture");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
