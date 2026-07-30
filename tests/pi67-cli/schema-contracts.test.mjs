import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSchemaPairs } from "../../packages/pi67-cli/scripts/checks/schema-contracts.mjs";
import { writeState } from "../../packages/pi67-cli/src/lib/state-store.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "packages", "pi67-cli", "bin", "pi-67.mjs");
const schemaRoot = path.join(repoRoot, "packages", "pi67-cli", "schemas");

test("all published schemas compile strictly and validate real payloads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-schema-contracts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = runCliJson("manifest", "--json");
  const update = runCliJson("update", "--check", "--json");
  const publish = runCliJson("publish-check", "--json", "--no-pack");
  const manifestPath = writeJson(root, "manifest.json", manifest);
  const updatePath = writeJson(root, "update-plan.json", update);
  const publishPath = writeJson(root, "publish-check.json", publish);
  const stateDir = path.join(root, "state");
  writeState({
    agentDir: path.join(root, "agent"),
    stateDir,
    repoRoot,
    skillsDir: path.join(repoRoot, "shared-skills"),
    packagesDir: path.join(root, "packages"),
  }, "schema-contract");

  const results = validateSchemaPairs([
    pair("pi67-distro-manifest.schema.json", manifestPath),
    pair("pi67-extension-registry.schema.json", path.join(repoRoot, "packages/pi67-cli/src/data/extension-registry.json")),
    pair("pi67-state.schema.json", path.join(stateDir, "state.json")),
    pair("pi67-update-plan.schema.json", updatePath),
    pair("pi67-publish-check.schema.json", publishPath),
  ]);
  assert.equal(results.length, 5);
  assert.deepEqual(results.filter((result) => !result.valid), []);
});

function runCliJson(...args) {
  const result = spawnSync(process.execPath, [
    cli,
    "--agent-dir", repoRoot,
    "--repo-root", repoRoot,
    "--skills-dir", path.join(repoRoot, "shared-skills"),
    "--no-remote",
    ...args,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeJson(root, name, payload) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

function pair(schemaName, dataPath) {
  return { schemaPath: path.join(schemaRoot, schemaName), dataPath };
}
