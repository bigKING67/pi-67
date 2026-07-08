import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError } from "./output.mjs";

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
  const conflicts = entries.filter((entry) => entry.conflict).length;
  return {
    schema: "pi67.skills-inventory.v1",
    sourceRoot,
    skillsDir: ctx.skillsDir,
    summary: {
      source: entries.length,
      missing: entries.filter((entry) => !entry.targetExists).length,
      identical: entries.filter((entry) => entry.identical).length,
      conflicts,
      preservedUserModified: conflicts,
    },
    entries,
  };
}

export function diffSkill(ctx, name) {
  const inventory = inventorySkills(ctx);
  const entry = inventory.entries.find((item) => item.name === name);
  if (!entry) {
    throw new CliError(`unknown shared skill: ${name}`, 2);
  }
  const sourceFiles = fileManifest(entry.source);
  const targetFiles = entry.targetExists ? fileManifest(entry.target) : new Map();
  const sourceNames = new Set(sourceFiles.keys());
  const targetNames = new Set(targetFiles.keys());
  const added = [...sourceNames].filter((rel) => !targetNames.has(rel)).sort();
  const removed = [...targetNames].filter((rel) => !sourceNames.has(rel)).sort();
  const modified = [...sourceNames]
    .filter((rel) => targetNames.has(rel) && sourceFiles.get(rel).sha256 !== targetFiles.get(rel).sha256)
    .sort();
  return {
    schema: "pi67.skills-diff.v1",
    name,
    source: entry.source,
    target: entry.target,
    sourceHash: entry.sourceHash,
    targetExists: entry.targetExists,
    targetHash: entry.targetHash,
    identical: entry.identical,
    conflict: entry.conflict,
    diff: {
      added,
      removed,
      modified,
      sourceFileCount: sourceFiles.size,
      targetFileCount: targetFiles.size,
    },
  };
}

export function planSkills(ctx, { names = [] } = {}) {
  const inventory = inventorySkills(ctx);
  const selected = normalizeNames(names, inventory);
  const entries = selected.length === 0
    ? inventory.entries.filter((entry) => !entry.identical)
    : inventory.entries.filter((entry) => selected.includes(entry.name) && !entry.identical);
  const actions = entries.map((entry) => ({
    name: entry.name,
    source: entry.source,
    target: entry.target,
    targetExists: entry.targetExists,
    conflict: entry.conflict,
    action: entry.conflict ? "preserve-conflict" : "copy-missing",
    reason: entry.conflict
      ? "target differs; default update preserves this user-modified global skill"
      : "target is missing and can be copied safely",
  }));
  return {
    schema: "pi67.skills-plan.v1",
    sourceRoot: inventory.sourceRoot,
    skillsDir: inventory.skillsDir,
    selected,
    summary: inventory.summary,
    actions,
  };
}

export function syncSkills(ctx, { dryRun = false, names = [], yes = false } = {}) {
  const inventory = inventorySkills(ctx);
  const selected = normalizeNames(names, inventory);
  const selectedSet = new Set(selected);
  const targeted = selected.length > 0;
  const actions = [];
  fs.mkdirSync(ctx.skillsDir, { recursive: true });
  for (const entry of inventory.entries) {
    if (targeted && !selectedSet.has(entry.name)) continue;
    if (entry.identical) {
      actions.push({ name: entry.name, action: "skip", reason: "identical" });
      continue;
    }
    if (entry.conflict) {
      if (!targeted || !yes) {
        actions.push({
          name: entry.name,
          action: "warn",
          reason: targeted
            ? "target differs; rerun with --yes to replace this explicitly named skill after backup"
            : "target differs; bulk overwrite of preserved user-modified skills is intentionally blocked",
        });
        continue;
      }
      const backupDir = path.join(ctx.stateDir, "backups", `${timestamp()}-skills-sync`, entry.name);
      actions.push({
        name: entry.name,
        action: dryRun ? "replace-dry-run" : "replace",
        reason: "target differs and was explicitly named with --yes",
        backupDir,
      });
      if (!dryRun) {
        fs.mkdirSync(path.dirname(backupDir), { recursive: true, mode: 0o700 });
        fs.cpSync(entry.target, backupDir, { recursive: true, force: true });
        fs.rmSync(entry.target, { recursive: true, force: true });
        fs.cpSync(entry.source, entry.target, { recursive: true, errorOnExist: true });
      }
      continue;
    }
    actions.push({ name: entry.name, action: dryRun ? "copy-dry-run" : "copy", reason: "missing" });
    if (!dryRun) {
      fs.cpSync(entry.source, entry.target, { recursive: true, errorOnExist: true });
    }
  }
  return { ...inventory, selected, actions };
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

function fileManifest(root) {
  const result = new Map();
  if (!fs.existsSync(root)) return result;
  const files = [];
  walk(root, files);
  for (const file of files.sort()) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const stat = fs.statSync(file);
    result.set(rel, {
      path: rel,
      bytes: stat.size,
      sha256: sha256File(file),
    });
  }
  return result;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function normalizeNames(names, inventory) {
  const selected = [...new Set((names || []).filter(Boolean).map(String))];
  const known = new Set(inventory.entries.map((entry) => entry.name));
  for (const name of selected) {
    if (!known.has(name)) {
      throw new CliError(`unknown shared skill: ${name}`, 2);
    }
  }
  return selected;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
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
