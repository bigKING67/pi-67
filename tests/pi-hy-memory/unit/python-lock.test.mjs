import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closureSha256,
  detectHyMemoryPythonTarget,
  parseHashedRequirements,
  pipInstallArguments,
  readHyMemoryPythonLock,
  sanitizedPythonInstallerEnvironment,
  uvSyncArguments,
  validatePythonRuntimeManifest,
} from "../../../packages/pi67-cli/src/lib/hy-memory-python-runtime.mjs";
import {
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  memoryRuntimeGenerationName,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const targetIds = [
  "cp311-macos-arm64",
  "cp311-manylinux_2_28-x64",
  "cp311-windows-x64",
];

test("Python lock target selection is explicit and unsupported targets fail closed", () => {
  assert.equal(detectHyMemoryPythonTarget({ platform: "darwin", arch: "arm64" }), "cp311-macos-arm64");
  assert.equal(
    detectHyMemoryPythonTarget({ platform: "linux", arch: "x64", libc: "glibc" }),
    "cp311-manylinux_2_28-x64",
  );
  assert.equal(detectHyMemoryPythonTarget({ platform: "win32", arch: "x64" }), "cp311-windows-x64");
  assert.throws(() => detectHyMemoryPythonTarget({ platform: "win32", arch: "arm64" }), /not qualified/);
  assert.throws(() => detectHyMemoryPythonTarget({ platform: "linux", arch: "x64", libc: "musl" }), /not qualified/);
  assert.throws(() => detectHyMemoryPythonTarget({ platform: "darwin", arch: "x64" }), /not qualified/);
});

test("all generated locks are exact, hashed, wheel-only inputs bound to canonical artifacts", () => {
  for (const targetId of targetIds) {
    const lock = readHyMemoryPythonLock(repoRoot, {
      targetId,
      requireQualified: false,
      hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
    });
    assert.equal(lock.requirements.length, lock.target.distributionCount);
    assert.ok(lock.requirements.every((item) => item.name && item.version && item.hashes.length > 0));
    assert.equal(lock.requirements.find((item) => item.name === "hy-memory")?.version, HY_MEMORY_SDK_VERSION);
    assert.ok(lock.requirements.find((item) => item.name === "hy-memory")?.hashes.includes(HY_MEMORY_WHEEL_SHA256));
  }
});

test("lock parser rejects unhashed, non-exact, URL, editable, Git and local requirements", () => {
  assert.throws(() => parseHashedRequirements("demo==1.0\n"), /has no SHA-256 hash/);
  assert.throws(() => parseHashedRequirements(`demo>=1.0 --hash=sha256:${"a".repeat(64)}\n`), /unsupported/);
  assert.throws(() => parseHashedRequirements("demo @ https://example.invalid/demo.whl\n"), /unsupported/);
  assert.throws(() => parseHashedRequirements("-e git+https://example.invalid/demo.git\n"), /unsupported/);
  assert.throws(() => parseHashedRequirements("./demo\n"), /unsupported/);
});

test("manifest and lock tampering fail before installer argv is created", () => {
  const fixture = createPythonSourceFixture();
  try {
    const manifestFile = path.join(fixture.pythonRoot, "lock-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.targets[0].sha256 = "0".repeat(64);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => readHyMemoryPythonLock(fixture.repoRoot, {
        targetId: targetIds[0],
        requireQualified: false,
        hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
      }),
      /lock .* SHA-256 does not match/,
    );
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("installer argv enforces hashes and wheels while environment drops index overrides", () => {
  const lock = readHyMemoryPythonLock(repoRoot, {
    targetId: targetIds[0],
    requireQualified: false,
    hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
  });
  const uvArgs = uvSyncArguments(lock, "/fixture/python");
  assert.ok(uvArgs.includes("--require-hashes"));
  assert.deepEqual(uvArgs.slice(uvArgs.indexOf("--only-binary"), uvArgs.indexOf("--only-binary") + 2), ["--only-binary", ":all:"]);
  assert.ok(uvArgs.includes("--strict"));
  const pipArgs = pipInstallArguments(lock);
  assert.ok(pipArgs.includes("--isolated"));
  assert.ok(pipArgs.includes("--require-hashes"));
  assert.ok(pipArgs.includes("--only-binary=:all:"));
  assert.ok(pipArgs.includes("--no-deps"));

  const env = sanitizedPythonInstallerEnvironment({
    PATH: "/fixture/bin",
    HTTPS_PROXY: "http://proxy.invalid",
    PIP_INDEX_URL: "https://secret.invalid/simple",
    UV_NO_VERIFY_HASHES: "1",
    UV_FIND_LINKS: "/untrusted",
  });
  assert.equal(env.PATH, "/fixture/bin");
  assert.equal(env.HTTPS_PROXY, "http://proxy.invalid");
  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.UV_NO_VERIFY_HASHES, undefined);
  assert.equal(env.UV_FIND_LINKS, undefined);
});

test("locked generation identity binds wrapper and dependency closure", () => {
  const wrapper = "1".repeat(64);
  const lock = "2".repeat(64);
  const standard = memoryRuntimeGenerationName(wrapper, { dependencyLockSha256: lock });
  const forced = memoryRuntimeGenerationName(wrapper, {
    dependencyLockSha256: lock,
    force: true,
    installationId: "a1b2c3d4e5f6",
  });
  assert.equal(standard, `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapper.slice(0, 12)}-pydeps-${lock.slice(0, 12)}`);
  assert.equal(forced, `${standard}-a1b2c3d4e5f6`);
  assert.throws(() => memoryRuntimeGenerationName(wrapper, { dependencyLockSha256: "bad" }), /dependency lock SHA-256/);
});

test("installed manifest detects missing, extra and version-drifted distributions", () => {
  const lock = readHyMemoryPythonLock(repoRoot, {
    targetId: targetIds[0],
    requireQualified: false,
    hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-python-manifest-"));
  const file = path.join(root, "python-runtime.json");
  try {
    const valid = runtimeManifest(lock, lock.requirements.map(({ name, version }) => ({ name, version })));
    writeManifest(file, valid);
    assert.equal(validatePythonRuntimeManifest(file, lock, HY_MEMORY_WHEEL_SHA256).distributionCount, lock.requirements.length);

    const missing = structuredClone(valid);
    missing.distributions.pop();
    finalizeClosure(missing);
    writeManifest(file, missing);
    assert.throws(() => validatePythonRuntimeManifest(file, lock, HY_MEMORY_WHEEL_SHA256), /missing or drifted/);

    const extra = structuredClone(valid);
    extra.distributions.push({ name: "unexpected", version: "1.0" });
    finalizeClosure(extra);
    writeManifest(file, extra);
    assert.throws(() => validatePythonRuntimeManifest(file, lock, HY_MEMORY_WHEEL_SHA256), /unexpected distribution/);

    const drifted = structuredClone(valid);
    drifted.distributions[0].version = "0.0.0";
    finalizeClosure(drifted);
    writeManifest(file, drifted);
    assert.throws(() => validatePythonRuntimeManifest(file, lock, HY_MEMORY_WHEEL_SHA256), /missing or drifted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createPythonSourceFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-python-lock-"));
  const pythonRoot = path.join(fixtureRoot, "extensions", "pi-hy-memory", "python");
  fs.mkdirSync(path.dirname(pythonRoot), { recursive: true });
  fs.cpSync(path.join(repoRoot, "extensions", "pi-hy-memory", "python"), pythonRoot, { recursive: true });
  return { repoRoot: fixtureRoot, pythonRoot };
}

function runtimeManifest(lock, distributions) {
  const machine = lock.target.arch === "arm64" ? "arm64" : "x86_64";
  const value = {
    schema: "pi67.hy-memory-python-runtime.v1",
    createdAt: "2026-07-31T00:00:00Z",
    lock: { id: lock.lockId, target: lock.target.id, sha256: lock.lockSha256 },
    python: {
      version: "3.11.13",
      implementation: "CPython",
      platform: lock.target.platform,
      machine,
      libc: lock.target.libc === "glibc" ? ["glibc", "2.28"] : ["", ""],
    },
    installer: { kind: "uv", version: "0.7.6" },
    policy: { requireHashes: true, onlyBinary: true },
    distributions: distributions.sort((left, right) => left.name.localeCompare(right.name)),
    distributionCount: distributions.length,
    closureSha256: "",
    hyMemory: { version: HY_MEMORY_SDK_VERSION, wheelSha256: HY_MEMORY_WHEEL_SHA256 },
  };
  finalizeClosure(value);
  return value;
}

function finalizeClosure(value) {
  value.distributions.sort((left, right) => left.name.localeCompare(right.name));
  value.distributionCount = value.distributions.length;
  value.closureSha256 = closureSha256(value.distributions);
}

function writeManifest(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
