import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectManagerFreshness } from "../../packages/pi67-cli/src/lib/manager-freshness.mjs";
import { captureOperationSnapshot } from "../../packages/pi67-cli/src/lib/operation-snapshot.mjs";

test("operation snapshot keeps manager, current, target, and live workspace distinct", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-operation-snapshot-"));
  try {
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(root, "state");
    const releasePath = path.join(stateDir, "releases", "0.15.6");
    const sourceRoot = path.join(root, "target");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(releasePath, { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "VERSION"), "0.15.7\n");
    fs.writeFileSync(path.join(stateDir, "current.json"), `${JSON.stringify({
      schema: "pi67.release-pointer.v1",
      version: "0.15.6",
      releasePath,
      agentDir,
    })}\n`);

    const snapshot = captureOperationSnapshot({
      agentDir,
      stateDir,
      repoRoot: sourceRoot,
    }, {
      sourceRoot,
      settings: { defaultProvider: "fixture", defaultModel: "fixture-model", theme: "fixture-theme" },
    });

    assert.equal(snapshot.schema, "pi67.operation-snapshot.v1");
    assert.equal(snapshot.current.kind, "immutable-release");
    assert.equal(snapshot.current.version, "0.15.6");
    assert.equal(snapshot.target.version, "0.15.7");
    assert.equal(snapshot.live.defaultProvider, "fixture");
    assert.notEqual(snapshot.manager.version, snapshot.current.version);

    fs.rmSync(releasePath, { recursive: true, force: true });
    const broken = captureOperationSnapshot({ agentDir, stateDir, repoRoot: sourceRoot }, { sourceRoot });
    assert.equal(broken.current.kind, "broken-release-pointer");
    assert.equal(broken.current.activated, false);
    assert.equal(broken.current.version, "0.15.6");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manager freshness accepts the operation snapshot package identity", async () => {
  const freshness = await inspectManagerFreshness({ noRemote: true }, {
    noRemote: true,
    manager: {
      package: "@bigking67/pi-67",
      version: "0.15.7",
      root: "/fixture/manager",
    },
    currentDistroVersion: "0.15.7",
  });
  assert.equal(freshness.package, "@bigking67/pi-67");
  assert.equal(freshness.updateCommand, "npm install -g @bigking67/pi-67@latest");
  assert.equal(freshness.blocking, false);
});
