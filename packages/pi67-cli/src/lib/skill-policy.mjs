import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError } from "./output.mjs";
import {
  SkillPackIntegrityError,
  hashDirectory,
  readSkillPackLock,
  validateSkillPackLock,
} from "./skill-pack-integrity.mjs";
import { withSkillDeployLock } from "./skill-deploy-lock.mjs";

const SKILL_PACK_REGISTRY = "shared-skill-packs.json";
const SKILL_PACK_LOCK = "shared-skill-packs.lock.json";

export function inventorySkills(ctx) {
  const sourceRoot = path.join(ctx.repoRoot, "shared-skills");
  const sourceNames = listSkillDirs(sourceRoot);
  const entries = sourceNames.map((name) => {
    const source = path.join(sourceRoot, name);
    const target = path.join(ctx.skillsDir, name);
    const sourceHash = hashDirectory(source);
    const targetExists = fs.existsSync(target);
    const targetHash = targetExists ? hashDirectory(target) : "";
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

export function inventorySkillPacks(ctx, { inventory = null, registry = null } = {}) {
  const registryPath = path.join(ctx.repoRoot, SKILL_PACK_REGISTRY);
  const lockPath = path.join(ctx.repoRoot, SKILL_PACK_LOCK);
  if (!fs.existsSync(registryPath)) {
    return {
      schema: "pi67.skill-packs-inventory.v1",
      registryPath,
      registryExists: false,
      lockPath,
      lockExists: fs.existsSync(lockPath),
      skillsDir: ctx.skillsDir,
      summary: {
        packs: 0,
        consistent: 0,
        attention: 0,
      },
      packs: [],
    };
  }

  const resolvedRegistry = registry || readSkillPackRegistry(registryPath);
  const skillInventory = inventory || inventorySkills(ctx);
  const byName = new Map(skillInventory.entries.map((entry) => [entry.name, entry]));
  const packs = resolvedRegistry.packs.map((pack) => {
    const entries = pack.skills.map((name) => {
      const entry = byName.get(name);
      if (!entry) {
        throw new CliError(`skill pack ${pack.name} references unknown shared skill: ${name}`, 2);
      }
      return entry;
    });
    return { pack, entries };
  });
  if (!fs.existsSync(lockPath)) {
    throw new SkillPackIntegrityError(`shared Skill Pack lock is missing: ${lockPath}`);
  }
  const lock = readSkillPackLock(lockPath);
  const sourceHashes = new Map(skillInventory.entries.map((entry) => [entry.name, entry.sourceHash]));
  const lockByName = validateSkillPackLock({ lock, registry: resolvedRegistry, sourceHashes });
  const resolvedPacks = packs.map(({ pack, entries }) => {
    const summary = {
      skills: entries.length,
      identical: entries.filter((entry) => entry.identical).length,
      missing: entries.filter((entry) => !entry.targetExists).length,
      conflicts: entries.filter((entry) => entry.conflict).length,
    };
    return {
      ...pack,
      summary,
      consistent: summary.identical === summary.skills,
      entries,
      provenance: {
        sourceCommit: lockByName.get(pack.name).source_commit,
        manifestSha256: lockByName.get(pack.name).manifest_sha256,
        bundleSha256: lockByName.get(pack.name).bundle_sha256,
        vendoredIntegrity: true,
      },
    };
  });
  return {
    schema: "pi67.skill-packs-inventory.v1",
    registryPath,
    registryExists: true,
    lockPath,
    lockExists: true,
    skillsDir: ctx.skillsDir,
    summary: {
      packs: resolvedPacks.length,
      consistent: resolvedPacks.filter((pack) => pack.consistent).length,
      attention: resolvedPacks.filter((pack) => !pack.consistent).length,
    },
    packs: resolvedPacks,
  };
}

export function inspectSkillPackStatus(ctx, { inventory = null } = {}) {
  const registryPath = path.join(ctx.repoRoot, SKILL_PACK_REGISTRY);
  const lockPath = path.join(ctx.repoRoot, SKILL_PACK_LOCK);
  let registry;
  try {
    if (!fs.existsSync(registryPath)) {
      throw new CliError(`shared Skill Pack registry is missing: ${registryPath}`, 2);
    }
    registry = readSkillPackRegistry(registryPath);
  } catch (error) {
    return invalidSkillPackStatus(ctx, {
      registryPath,
      registryValid: false,
      lockPath,
      lockValid: false,
      error,
    });
  }
  try {
    const packInventory = inventorySkillPacks(ctx, { inventory, registry });
    return {
      schemaId: "pi67-shared-skill-packs-status/v1",
      registry: {
        path: registryPath,
        exists: true,
        valid: true,
      },
      lock: {
        path: lockPath,
        exists: true,
        valid: true,
      },
      skillsDir: ctx.skillsDir,
      summary: packInventory.summary,
      packs: packInventory.packs.map((pack) => ({
        name: pack.name,
        version: pack.version,
        owner: pack.owner || "",
        distribution: pack.distribution || "",
        upstream: pack.upstream || "",
        skills: pack.summary.skills,
        identical: pack.summary.identical,
        missing: pack.summary.missing,
        conflicts: pack.summary.conflicts,
        consistent: pack.consistent,
        provenance: pack.provenance,
        missingSkills: pack.entries.filter((entry) => !entry.targetExists).map((entry) => entry.name),
        conflictSkills: pack.entries.filter((entry) => entry.conflict).map((entry) => entry.name),
        commands: {
          inspect: "pi-67 skills packs",
          preview: `pi-67 skills sync-pack ${pack.name} --dry-run`,
        },
      })),
      errors: [],
    };
  } catch (error) {
    const lockInvalid = error instanceof SkillPackIntegrityError;
    return invalidSkillPackStatus(ctx, {
      registryPath,
      registryValid: lockInvalid,
      lockPath,
      lockValid: false,
      error,
    });
  }
}

export function syncSkillPack(ctx, name, { dryRun = false, yes = false } = {}) {
  const inventory = inventorySkillPacks(ctx);
  const pack = inventory.packs.find((entry) => entry.name === name);
  if (!pack) {
    throw new CliError(`unknown shared skill pack: ${name}`, 2);
  }
  const result = syncSkills(ctx, { dryRun, names: pack.skills, yes });
  const selected = new Set(pack.skills);
  const entries = result.entries.filter((entry) => selected.has(entry.name));
  return {
    ...result,
    schema: "pi67.skill-pack-sync.v1",
    summary: {
      source: entries.length,
      missing: entries.filter((entry) => !entry.targetExists).length,
      identical: entries.filter((entry) => entry.identical).length,
      conflicts: entries.filter((entry) => entry.conflict).length,
      preservedUserModified: entries.filter((entry) => entry.conflict).length,
    },
    entries,
    pack: {
      name: pack.name,
      version: pack.version,
      upstream: pack.upstream,
      skills: pack.skills,
      provenance: pack.provenance,
    },
  };
}

function invalidSkillPackStatus(ctx, {
  registryPath,
  registryValid,
  lockPath,
  lockValid,
  error,
}) {
  return {
    schemaId: "pi67-shared-skill-packs-status/v1",
    registry: {
      path: registryPath,
      exists: fs.existsSync(registryPath),
      valid: registryValid,
    },
    lock: {
      path: lockPath,
      exists: fs.existsSync(lockPath),
      valid: lockValid,
    },
    skillsDir: ctx.skillsDir,
    summary: {
      packs: 0,
      consistent: 0,
      attention: 1,
    },
    packs: [],
    errors: [error instanceof Error ? error.message : String(error)],
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

export function syncSkills(ctx, {
  dryRun = false,
  names = [],
  yes = false,
} = {}) {
  if (dryRun) {
    const plan = buildSkillSyncPlan(ctx, { dryRun: true, names, yes });
    return finishSkillSync(ctx, plan, { dryRun: true, recoveredTransactions: [] });
  }
  return withSkillDeployLock(ctx, "skills-sync", () => {
    const recoveredTransactions = cleanupStaleSkillTransactions(ctx.skillsDir);
    const lockedPlan = buildSkillSyncPlan(ctx, { dryRun: false, names, yes });
    return finishSkillSync(ctx, lockedPlan, { dryRun: false, recoveredTransactions });
  });
}

function buildSkillSyncPlan(ctx, { dryRun, names, yes }) {
  const inventory = inventorySkills(ctx);
  const selected = normalizeNames(names, inventory);
  const selectedSet = new Set(selected);
  const targeted = selected.length > 0;
  const actions = [];
  const operations = [];
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
            ? "target differs; publish desired changes in a new pi-67 release or rerun with --yes to restore this release baseline"
            : "target differs; bulk overwrite of preserved user-modified skills is intentionally blocked",
        });
        continue;
      }
      actions.push({
        name: entry.name,
        action: dryRun ? "replace-dry-run" : "replace",
        reason: "target differs and was explicitly restored from the current release-bundled source with --yes",
      });
      operations.push({ entry, action: "replace" });
      continue;
    }
    actions.push({ name: entry.name, action: dryRun ? "copy-dry-run" : "copy", reason: "missing" });
    operations.push({ entry, action: "copy" });
  }
  return { inventory, selected, actions, operations };
}

function finishSkillSync(ctx, plan, { dryRun, recoveredTransactions }) {
  const { inventory, selected, actions, operations } = plan;
  if (!dryRun && operations.length > 0) applySkillOperations(ctx, operations);
  return { ...inventory, selected, actions, recoveredTransactions };
}

function applySkillOperations(ctx, operations) {
  fs.mkdirSync(ctx.skillsDir, { recursive: true });
  const transactionRoot = path.join(ctx.skillsDir, `.pi67-skills-sync-${transactionId()}`);
  const stagedRoot = path.join(transactionRoot, "staged");
  const previousRoot = path.join(transactionRoot, "previous");
  const activated = [];
  const movedPrevious = [];
  try {
    fs.mkdirSync(stagedRoot, { recursive: true });
    for (const operation of operations) {
      fs.cpSync(operation.entry.source, path.join(stagedRoot, operation.entry.name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    for (const operation of operations) {
      const targetExists = fs.existsSync(operation.entry.target);
      if (operation.action === "copy" && targetExists) {
        throw new Error(`Skill sync target appeared during transaction: ${operation.entry.name}`);
      }
      if (operation.action === "replace" && !targetExists) {
        throw new Error(`Skill sync target disappeared during transaction: ${operation.entry.name}`);
      }
      if (
        operation.action === "replace"
        && hashDirectory(operation.entry.target) !== operation.entry.targetHash
      ) {
        throw new Error(`Skill sync target changed during transaction: ${operation.entry.name}`);
      }
      if (!targetExists) continue;
      fs.mkdirSync(previousRoot, { recursive: true });
      fs.renameSync(operation.entry.target, path.join(previousRoot, operation.entry.name));
      movedPrevious.push(operation.entry.name);
    }
    for (const operation of operations) {
      fs.renameSync(path.join(stagedRoot, operation.entry.name), operation.entry.target);
      activated.push(operation.entry.name);
    }
    for (const operation of operations) {
      if (hashDirectory(operation.entry.source) !== hashDirectory(operation.entry.target)) {
        throw new Error(`Skill sync hash mismatch: ${operation.entry.name}`);
      }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    for (const name of activated.reverse()) {
      fs.rmSync(path.join(ctx.skillsDir, name), { recursive: true, force: true });
    }
    for (const name of movedPrevious.reverse()) {
      const previous = path.join(previousRoot, name);
      if (fs.existsSync(previous)) fs.renameSync(previous, path.join(ctx.skillsDir, name));
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupStaleSkillTransactions(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".pi67-skills-sync-")) continue;
    const target = path.join(skillsDir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

function listSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
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

function readSkillPackRegistry(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`invalid shared skill pack registry: ${error.message}`, 2);
  }
  if (payload?.schema !== "pi67.shared-skill-packs.v1" || !Array.isArray(payload.packs)) {
    throw new CliError("invalid shared skill pack registry schema", 2);
  }
  const names = new Set();
  const skillOwners = new Map();
  for (const pack of payload.packs) {
    if (!pack || typeof pack.name !== "string" || !pack.name || typeof pack.version !== "string") {
      throw new CliError("shared skill pack entries require name and version", 2);
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pack.version)) {
      throw new CliError(`shared skill pack ${pack.name} requires a SemVer version`, 2);
    }
    if (names.has(pack.name)) {
      throw new CliError(`duplicate shared skill pack: ${pack.name}`, 2);
    }
    names.add(pack.name);
    if (
      !Array.isArray(pack.skills) ||
      pack.skills.length === 0 ||
      pack.skills.some((name) => typeof name !== "string" || !name) ||
      new Set(pack.skills).size !== pack.skills.length
    ) {
      throw new CliError(`shared skill pack ${pack.name} requires unique skill names`, 2);
    }
    for (const skill of pack.skills) {
      const owner = skillOwners.get(skill);
      if (owner) {
        throw new CliError(`shared skill ${skill} is assigned to multiple packs: ${owner}, ${pack.name}`, 2);
      }
      skillOwners.set(skill, pack.name);
    }
  }
  return payload;
}

function transactionId() {
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
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
