import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmPublishTargetStatus } from "../src/lib/npm-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
walk(path.join(root, "bin"), files);
walk(path.join(root, "src"), files);
walk(path.join(root, "schemas"), files);
for (const file of files.filter((item) => item.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of files.filter((item) => item.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(file, "utf8"));
}
runPublishTargetSelfTests();

function walk(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
}

function runPublishTargetSelfTests() {
  const unpublished = {
    skipped: false,
    ok: false,
    message: "not published on npm registry yet",
  };
  const visibleScope = {
    skipped: false,
    ok: true,
    blocking: false,
    scoped: true,
    scope: "@example",
    message: "visible",
  };
  const missingScope = {
    skipped: false,
    ok: false,
    blocking: true,
    scoped: true,
    scope: "@example",
    code: "scope_missing",
    message: "missing",
  };
  assert(
    npmPublishTargetStatus("@example/pkg", { registry: unpublished, scope: visibleScope }).code ===
      "first_publish_requires_confirmation",
    "first publish must require explicit confirmation",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: visibleScope,
      allowFirstPublish: true,
    }).ok,
    "confirmed first publish with visible scope should pass the local target gate",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: missingScope,
    }).blocking,
    "missing scope must block unconfirmed first publish",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: missingScope,
      allowFirstPublish: true,
    }).code === "first_publish_scope_probe_confirmed",
    "explicit first-publish confirmation should allow npm publish to be the authority for a new scope",
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
