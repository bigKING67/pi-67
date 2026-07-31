import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig, readRuntime, resolveHyMemoryPaths, validateConfig } from "../../../extensions/pi-hy-memory/config.ts";
import { ensureHyMemoryService } from "../../../extensions/pi-hy-memory/client.ts";
import {
  defaultMemoryConfig,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

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

test("extension runtime loader enforces managed wrapper and Python identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-extension-runtime-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const wrapper = Buffer.from("managed-wrapper");
    const wrapperSha256 = crypto.createHash("sha256").update(wrapper).digest("hex");
    const generation = path.join(
      paths.runtimeDir,
      `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}`,
    );
    const python = runtimePython(generation);
    const serviceScript = path.join(generation, "service.py");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "fixture-python");
    fs.writeFileSync(serviceScript, wrapper);
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python,
      serviceScript,
      wrapperSha256,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    assert.equal(readRuntime(paths).wrapperSha256, wrapperSha256);
    fs.writeFileSync(serviceScript, "tampered-wrapper");
    assert.throws(() => readRuntime(paths), /wrapper SHA-256 does not match/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension runtime loader accepts isolated forced generation identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-extension-forced-runtime-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const wrapper = Buffer.from("forced-managed-wrapper");
    const wrapperSha256 = crypto.createHash("sha256").update(wrapper).digest("hex");
    const generation = path.join(
      paths.runtimeDir,
      `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}-a1b2c3d4e5f6`,
    );
    const python = runtimePython(generation);
    const serviceScript = path.join(generation, "service.py");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "fixture-python");
    fs.writeFileSync(serviceScript, wrapper);
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python,
      serviceScript,
      wrapperSha256,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    assert.equal(readRuntime(paths).serviceScript, serviceScript);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension runtime loader validates dependency-locked generation and installed manifest identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-extension-locked-runtime-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const wrapper = Buffer.from("locked-managed-wrapper");
    const wrapperSha256 = crypto.createHash("sha256").update(wrapper).digest("hex");
    const lockSha256 = "2".repeat(64);
    const generation = path.join(
      paths.runtimeDir,
      `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}-pydeps-${lockSha256.slice(0, 12)}`,
    );
    const python = runtimePython(generation);
    const serviceScript = path.join(generation, "service.py");
    const pythonRuntimeManifest = path.join(generation, "python-runtime.json");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "fixture-python");
    fs.writeFileSync(serviceScript, wrapper);
    fs.writeFileSync(pythonRuntimeManifest, `${JSON.stringify({
      schema: "pi67.hy-memory-python-runtime.v1",
      lock: { id: `sha256:${lockSha256}`, target: "cp311-macos-arm64", sha256: lockSha256 },
      policy: { requireHashes: true, onlyBinary: true },
      hyMemory: { version: HY_MEMORY_SDK_VERSION, wheelSha256: HY_MEMORY_WHEEL_SHA256 },
    })}\n`);
    const pythonRuntimeManifestSha256 = crypto.createHash("sha256")
      .update(fs.readFileSync(pythonRuntimeManifest))
      .digest("hex");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v2",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python,
      serviceScript,
      wrapperSha256,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      dependencyLockId: `sha256:${lockSha256}`,
      dependencyLockTarget: "cp311-macos-arm64",
      dependencyLockSha256: lockSha256,
      pythonRuntimeManifest,
      pythonRuntimeManifestSha256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    assert.equal(readRuntime(paths).dependencyLockSha256, lockSha256);
    fs.appendFileSync(pythonRuntimeManifest, " ");
    assert.throws(() => readRuntime(paths), /manifest SHA-256/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension runtime loader rejects unmanaged activation metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-extension-unmanaged-"));
  try {
    const paths = resolveHyMemoryPaths(root);
    const unmanagedRoot = path.join(root, "unmanaged");
    fs.mkdirSync(unmanagedRoot, { recursive: true });
    const serviceScript = path.join(unmanagedRoot, "service.py");
    fs.writeFileSync(serviceScript, "unmanaged-wrapper");
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: process.execPath,
      serviceScript,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    assert.throws(() => readRuntime(paths), /outside its managed generation/);
    await assert.rejects(
      ensureHyMemoryService(defaultMemoryConfig("extension-activation-user"), paths, 100),
      /outside its managed generation/,
    );
    assert.equal(fs.existsSync(paths.startLockFile), false, "invalid activation must be rejected before taking the start lock");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runtimePython(generation) {
  return process.platform === "win32"
    ? path.join(generation, "venv", "Scripts", "python.exe")
    : path.join(generation, "venv", "bin", "python");
}
