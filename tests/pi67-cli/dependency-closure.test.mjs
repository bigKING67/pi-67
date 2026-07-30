import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectDependencyClosure } from "../../scripts/pi67-dependency-closure-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("repository dependency closure has one exact Pi type host", () => {
  const report = inspectDependencyClosure(repoRoot);
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.deepEqual(report.physicalPiPackages, [{
    name: "@earendil-works/pi-coding-agent",
    version: "0.80.6",
    path: "npm/node_modules/@earendil-works/pi-coding-agent",
  }]);
});

test("release runtime preparation omits peers and verifies its physical closure", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "pi67-release.sh"), "utf8");
  assert.match(source, /ci --ignore-scripts --omit=peer --no-audit/);
  assert.ok((source.match(/pi67-dependency-closure-check\.mjs/g) || []).length >= 2);
});

test("dependency closure rejects a nested legacy Pi runtime", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-dependency-closure-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  copyContractFiles(fixture);
  const legacy = path.join(fixture, "npm", "node_modules", "fixture", "node_modules", "@mariozechner", "pi-coding-agent");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "package.json"), '{"name":"@mariozechner/pi-coding-agent","version":"0.73.1"}\n');

  const report = inspectDependencyClosure(fixture);
  assert.equal(report.ok, false);
  assert.match(report.problems.join("; "), /expected exactly one physical Pi type host, found 2/);
});

function copyContractFiles(fixture) {
  for (const relative of [
    "package.json",
    "package-lock.json",
    "tsconfig.xtalpi.json",
    "tsconfig.hy-memory.json",
    "npm/package.json",
    "npm/package-lock.json",
  ]) {
    const target = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  const sourceHost = path.join(repoRoot, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const targetHost = path.join(fixture, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  fs.mkdirSync(path.dirname(targetHost), { recursive: true });
  fs.copyFileSync(sourceHost, targetHost);
}
