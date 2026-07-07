import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function inventorySkills(ctx) {
  const sourceRoot = path.join(ctx.repoRoot, "shared-skills");
  const sourceNames = listSkillDirs(sourceRoot);
  const entries = sourceNames.map((name) => {
    const source = path.join(sourceRoot, name);
    const target = path.join(ctx.skillsDir, name);
    const sourceHash = hashDir(source);
    const targetExists = fs.existsSync(target);
    const targetHash = targetExists ? hashDir(target) : "";
    const identical = targetExists && sourceHash === targetHash;
    const conflict = targetExists && !identical;
    return { name, source, target, sourceHash, targetExists, targetHash, identical, conflict };
  });
  return {
    schema: "pi67.skills-inventory.v1",
    sourceRoot,
    skillsDir: ctx.skillsDir,
    summary: {
      source: entries.length,
      missing: entries.filter((entry) => !entry.targetExists).length,
      identical: entries.filter((entry) => entry.identical).length,
      conflicts: entries.filter((entry) => entry.conflict).length,
    },
    entries,
  };
}

export function syncSkills(ctx, { dryRun = false } = {}) {
  const inventory = inventorySkills(ctx);
  const actions = [];
  fs.mkdirSync(ctx.skillsDir, { recursive: true });
  for (const entry of inventory.entries) {
    if (entry.identical) {
      actions.push({ name: entry.name, action: "skip", reason: "identical" });
      continue;
    }
    if (entry.conflict) {
      actions.push({ name: entry.name, action: "warn", reason: "target differs; preserved" });
      continue;
    }
    actions.push({ name: entry.name, action: dryRun ? "copy-dry-run" : "copy", reason: "missing" });
    if (!dryRun) {
      fs.cpSync(entry.source, entry.target, { recursive: true, errorOnExist: true });
    }
  }
  return { ...inventory, actions };
}

function listSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function hashDir(root) {
  if (!fs.existsSync(root)) return "";
  const hash = crypto.createHash("sha256");
  const files = [];
  walk(root, files);
  for (const file of files.sort()) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}
