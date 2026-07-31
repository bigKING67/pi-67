import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureRuntimeSelection,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  installMemoryRuntime,
  inventoryMemoryRuntimes,
  memoryRuntimeGenerationName,
  memoryPaths,
  planMemoryRuntimePrune,
  restoreRuntimeSelection,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";
import { readHyMemoryPythonLock } from "../../../packages/pi67-cli/src/lib/hy-memory-python-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("runtime inventory protects current and previous generations and selects only older managed candidates", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-inventory-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 3_000, "current-content");
    const previous = createGeneration(paths.runtimeDir, 2_000, "previous-content");
    const old = createGeneration(paths.runtimeDir, 1_000, "old-content");
    fs.mkdirSync(path.join(paths.runtimeDir, "manual-runtime"));
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.selectionValid, true);
    assert.equal(inventory.generationCount, 3);
    assert.equal(inventory.current.root, current);
    assert.deepEqual(inventory.current.protectedReasons, ["current"]);
    assert.equal(inventory.previous.root, previous);
    assert.deepEqual(inventory.previous.protectedReasons, ["previous"]);
    assert.deepEqual(inventory.pruneCandidates.map((item) => item.root), [old]);
    assert.equal(inventory.totalBytesComplete, true);
    assert.ok(inventory.totalBytes > 0);
    assert.ok(inventory.ignoredEntries >= 2, "current.json and unmanaged directories must be ignored");

    const plan = planMemoryRuntimePrune({ home });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.executable, false);
    assert.match(plan.planId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(plan.preconditionsReady, true);
    assert.ok(plan.readiness.every((item) => item.ok));
    assert.deepEqual(plan.blockedReasons, ["deletion-not-implemented"]);
    assert.deepEqual(plan.wouldDelete.map((item) => item.root), [old]);
    assert.ok(plan.reclaimableBytes > 0);
    assert.equal(plan.planId, planMemoryRuntimePrune({ home }).planId, "unchanged inventory must produce a stable plan ID");
    assert.equal(fs.existsSync(old), true, "planning must never remove a generation");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime inventory fails closed when current metadata escapes the managed runtime root", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-escape-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    createGeneration(paths.runtimeDir, 2_000, "managed-one");
    createGeneration(paths.runtimeDir, 1_000, "managed-two");
    const outside = path.join(home, "outside-runtime");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "service.py"), "outside");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: path.join(outside, "python"),
      serviceScript: path.join(outside, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.selectionValid, false);
    assert.equal(inventory.current, null);
    assert.equal(inventory.previous, null);
    assert.deepEqual(inventory.pruneCandidates, []);
    assert.match(inventory.issues.join("\n"), /outside a managed generation/);

    const plan = planMemoryRuntimePrune({ home });
    assert.equal(plan.executable, false);
    assert.deepEqual(plan.wouldDelete, []);
    assert.ok(plan.blockedReasons.includes("runtime-selection-invalid"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime inventory protects every generation while a live service owner exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-live-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 3_000, "current-content");
    createGeneration(paths.runtimeDir, 2_000, "previous-content");
    createGeneration(paths.runtimeDir, 1_000, "old-content");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);
    const ownership = {
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: 12345,
      instanceId: "runtime-inventory-live-fixture",
      root: paths.root,
      dataDir: paths.dataDir,
    };
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify(ownership)}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify(ownership)}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.serviceRunning, true);
    assert.equal(inventory.serviceTopology, "owned");
    assert.deepEqual(inventory.pruneCandidates, []);
    assert.ok(inventory.generations.every((item) => item.protectedReasons.includes("service-running")));

    const plan = planMemoryRuntimePrune({ home });
    assert.ok(plan.blockedReasons.includes("service-running"));
    assert.equal(plan.preconditionsReady, false);
    assert.deepEqual(plan.wouldDelete, []);

    fs.unlinkSync(paths.serviceFile);
    fs.unlinkSync(paths.lifetimeOwnerFile);
    const stoppedPlan = planMemoryRuntimePrune({ home });
    assert.notEqual(stoppedPlan.planId, plan.planId, "service topology changes must invalidate the plan identity");
    assert.equal(stoppedPlan.preconditionsReady, true);
    assert.equal(stoppedPlan.wouldDelete.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime inventory rejects a current wrapper whose content no longer matches its generation identity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-tampered-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 2_000, "current-content");
    createGeneration(paths.runtimeDir, 1_000, "previous-content");
    fs.writeFileSync(path.join(current, "service.py"), "tampered-content");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.selectionValid, false);
    assert.equal(inventory.current.wrapperHashMatchesName, false);
    assert.ok(inventory.current.protectedReasons.includes("integrity-invalid"));
    assert.deepEqual(inventory.pruneCandidates, []);

    const plan = planMemoryRuntimePrune({ home });
    assert.equal(plan.preconditionsReady, false);
    assert.ok(plan.blockedReasons.includes("runtime-selection-invalid"));
    assert.ok(plan.blockedReasons.includes("current-wrapper-invalid"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime inventory rejects wrapper content that disagrees with the full metadata hash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-metadata-hash-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 2_000, "current-content");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wrapperSha256: "0".repeat(64),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.selectionValid, false);
    assert.equal(inventory.current.wrapperHashMatchesName, true);
    assert.match(inventory.issues.join("\n"), /wrapper SHA-256 does not match runtime metadata/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime prune readiness requires an intact previous rollback generation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-no-rollback-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 1_000, "only-current-content");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const plan = planMemoryRuntimePrune({ home });
    assert.equal(plan.preconditionsReady, false);
    assert.ok(plan.blockedReasons.includes("rollback-generation-unavailable"));
    assert.deepEqual(plan.wouldDelete, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime prune refuses a dependency-locked rollback generation without its installed manifest", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-locked-rollback-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const current = createGeneration(paths.runtimeDir, 2_000, "current-legacy");
    const lockedBase = createGeneration(paths.runtimeDir, 3_000, "locked-previous");
    const lockSha256 = "2".repeat(64);
    const locked = `${lockedBase}-pydeps-${lockSha256.slice(0, 12)}`;
    fs.renameSync(lockedBase, locked);
    const wrapperSha256 = crypto.createHash("sha256").update("current-legacy").digest("hex");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(current),
      serviceScript: path.join(current, "service.py"),
      wrapperSha256,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.previous.root, locked);
    assert.equal(inventory.previous.pythonRuntimeManifestValid, false);
    assert.ok(inventory.previous.protectedReasons.includes("integrity-invalid"));
    const plan = planMemoryRuntimePrune({ home });
    assert.equal(plan.preconditionsReady, false);
    assert.ok(plan.blockedReasons.includes("rollback-generation-unavailable"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime install refuses to reuse a generation with a tampered wrapper", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-reuse-tampered-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const source = fs.readFileSync(path.join(repoRoot, "extensions", "pi-hy-memory", "service.py"), "utf8");
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    const lock = readHyMemoryPythonLock(repoRoot, { hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256 });
    const generation = createGeneration(paths.runtimeDir, Date.now(), source);
    const lockedGeneration = path.join(
      paths.runtimeDir,
      memoryRuntimeGenerationName(sourceHash, { dependencyLockSha256: lock.lockSha256 }),
    );
    fs.renameSync(generation, lockedGeneration);
    fs.writeFileSync(path.join(lockedGeneration, "python-runtime.json"), "{}\n");
    fs.writeFileSync(path.join(lockedGeneration, "service.py"), "tampered-content");

    await assert.rejects(
      installMemoryRuntime({ repoRoot }, { paths }),
      /wrapper SHA-256 does not match its managed generation/,
    );
    assert.equal(fs.existsSync(paths.runtimeFile), false, "tampered reuse must not activate current.json");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("forced runtime staging always selects a fresh generation instead of mutating the active generation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-force-symlink-"));
  try {
    const paths = memoryPaths(home);
    const source = fs.readFileSync(path.join(repoRoot, "extensions", "pi-hy-memory", "service.py"), "utf8");
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
    const active = memoryRuntimeGenerationName(sourceHash);
    const forced = memoryRuntimeGenerationName(sourceHash, { force: true, installationId: "a1b2c3d4e5f6" });

    assert.equal(active, `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${sourceHash.slice(0, 12)}`);
    assert.equal(forced, `${active}-a1b2c3d4e5f6`);
    assert.notEqual(forced, active);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runtime rollback preserves legacy current.json bytes and accepts forced generation inventory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-selection-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const prior = createGeneration(paths.runtimeDir, 1_000, "prior-selection");
    const candidateBase = createGeneration(paths.runtimeDir, 2_000, "candidate-selection");
    const candidate = `${candidateBase}-a1b2c3d4e5f6`;
    fs.renameSync(candidateBase, candidate);
    const priorMetadata = {
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: runtimePython(prior),
      serviceScript: path.join(prior, "service.py"),
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: "2026-07-31T00:00:00.000Z",
    };
    const priorBytes = Buffer.from(`${JSON.stringify(priorMetadata)}\n`);
    fs.writeFileSync(paths.runtimeFile, priorBytes);
    const snapshot = captureRuntimeSelection(paths);
    const candidateWrapperSha256 = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(candidate, "service.py")))
      .digest("hex");
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      ...priorMetadata,
      python: runtimePython(candidate),
      serviceScript: path.join(candidate, "service.py"),
      wrapperSha256: candidateWrapperSha256,
    })}\n`);

    const inventory = inventoryMemoryRuntimes({ home });
    assert.equal(inventory.current.root, candidate);
    assert.equal(inventory.selectionValid, true);
    restoreRuntimeSelection(paths, snapshot);
    assert.deepEqual(fs.readFileSync(paths.runtimeFile), priorBytes);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function createGeneration(runtimeDir, modifiedAtMs, content) {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  const root = path.join(runtimeDir, `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${hash}`);
  const python = runtimePython(root);
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(path.join(root, "service.py"), content);
  fs.writeFileSync(python, "fixture-python");
  const modifiedAt = new Date(modifiedAtMs);
  fs.utimesSync(root, modifiedAt, modifiedAt);
  return root;
}

function runtimePython(root) {
  return process.platform === "win32"
    ? path.join(root, "venv", "Scripts", "python.exe")
    : path.join(root, "venv", "bin", "python");
}
