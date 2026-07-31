import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HY_MEMORY_WHEEL_SHA256,
  memoryPaths,
  stageMemoryRuntime,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";
import {
  detectHyMemoryPythonTarget,
  readHyMemoryPythonLock,
  validatePythonRuntimeManifest,
} from "../../../packages/pi67-cli/src/lib/hy-memory-python-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.PI67_HY_MEMORY_PYTHON_INSTALL_TEST === "1";

test("native Python 3.11 lock clean-installs into an isolated generation", { skip: !enabled, timeout: 35 * 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-python-install-"));
  try {
    const targetId = detectHyMemoryPythonTarget();
    const lock = readHyMemoryPythonLock(repoRoot, {
      targetId,
      requireQualified: false,
      hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
    });
    const paths = memoryPaths(home);
    const staged = await stageMemoryRuntime({ repoRoot }, {
      paths,
      pythonLockTarget: targetId,
      requireQualifiedPythonLock: false,
    });

    assert.equal(staged.created, true);
    assert.equal(staged.reused, false);
    assert.equal(staged.runtime.schema, "pi67-hy-memory-runtime/v2");
    assert.equal(staged.runtime.dependencyLockTarget, targetId);
    assert.equal(staged.runtime.dependencyLockSha256, lock.lockSha256);
    assert.match(path.basename(staged.root), /-pydeps-[0-9a-f]{12}$/);
    assert.equal(fs.existsSync(paths.runtimeFile), false, "staging must not activate current.json");
    assert.equal(fs.existsSync(staged.runtime.pythonRuntimeManifest), true);
    validatePythonRuntimeManifest(staged.runtime.pythonRuntimeManifest, lock, HY_MEMORY_WHEEL_SHA256);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
