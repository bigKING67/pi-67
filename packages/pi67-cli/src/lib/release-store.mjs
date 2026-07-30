import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import {
  canonicalPathIdentity,
  isPathStrictlyWithin,
  recoverPendingFileTransactions,
  runFileTransaction,
} from "./file-transaction.mjs";
import { CliError } from "./output.mjs";
import { defaultAgentDir, packageRoot, readTextIfExists } from "./paths.mjs";
import { PRESERVED_RUNTIME_FILES } from "./runtime-layout-policy.mjs";

const BUNDLE_SCHEMA = "pi67.distro-bundle.v1";
const POINTER_SCHEMA = "pi67.release-pointer.v1";
const JOURNAL_SCHEMA = "pi67.release-activation.v1";
const MIGRATION_SCHEMA = "pi67.runtime-migration.v1";
const BUNDLE_MANIFEST = ".pi67-bundle.json";
const PENDING_ACTIVATION = "pending-activation.json";

const ACTIVE_EXCLUDED_PREFIXES = [
  ".git/",
  "extensions/",
  "git/",
  "node_modules/",
  "npm/",
  "sessions/",
  "tmp/",
];

const MIGRATION_RUNTIME_DIRS = ["extensions", "git", "npm", "sessions"];

// Keep source-checkout staging consistent with the npm-packed immutable bundle.
const SOURCE_DISTRO_FILES = new Set([
  ".gitattributes", "AGENTS.md", "CHANGELOG.md", "LICENSE", "README.md", "VERSION",
  "auth.example.json", "image-gen.example.json", "install.ps1", "install.sh", "mcp.example.json",
  "models.example.json", "package-lock.json", "package.json", "settings.example.json",
  "shared-skill-packs.json", "shared-skill-packs.lock.json", "tsconfig.hy-memory.json", "tsconfig.json",
  "tsconfig.xtalpi.json",
]);

const SOURCE_DISTRO_DIRS = new Set([
  "bin", "docs", "extensions", "prompts", "rules", "scripts", "shared-skills", "templates", "tests", "themes",
]);

export function bundledDistroRoot() {
  return path.join(packageRoot(), "distro");
}

export function currentReleasePath(ctx) {
  const current = readCurrentRelease(ctx);
  return current?.releasePath && fs.existsSync(current.releasePath) ? current.releasePath : "";
}

export function resolveDistroSourceRoot(ctx, options = {}) {
  const requested = options.sourceRoot ? path.resolve(options.sourceRoot) : "";
  if (requested && hasDistro(requested)) return requested;
  const bundled = bundledDistroRoot();
  if (hasDistro(bundled)) return bundled;
  const current = currentReleasePath(ctx);
  if (current && hasDistro(current)) return current;
  if (hasDistro(ctx.repoRoot)) return ctx.repoRoot;
  throw new CliError("pi-67 distro assets are unavailable; reinstall the pi-67 manager package", 2);
}

export function readCurrentRelease(ctx) {
  const file = currentPointerPath(ctx);
  const payload = readJsonFileIfExists(file);
  if (!payload) return null;
  if (payload.schema !== POINTER_SCHEMA || !payload.version || !payload.releasePath) {
    throw new CliError(`invalid pi-67 release pointer: ${file}`, 2);
  }
  const pointerAgentDir = payload.agentDir || defaultAgentDir();
  if (realPathMaybe(pointerAgentDir) !== realPathMaybe(ctx.agentDir)) return null;
  return payload;
}

export function stageDistroRelease(ctx, options = {}) {
  const sourceRoot = resolveDistroSourceRoot(ctx, options);
  const version = distroVersion(sourceRoot);
  const releasePath = path.join(ctx.stateDir, "releases", version);
  if (path.resolve(sourceRoot) === path.resolve(releasePath)) {
    verifyDistro(sourceRoot, version);
    return { version, sourceRoot, releasePath, created: false, reused: true };
  }
  if (fs.existsSync(releasePath)) {
    verifyDistro(releasePath, version);
    assertSameDistro(sourceRoot, releasePath);
    return { version, sourceRoot, releasePath, created: false, reused: true };
  }
  if (options.dryRun) {
    return { version, sourceRoot, releasePath, created: false, reused: false, dryRun: true };
  }
  fs.mkdirSync(path.dirname(releasePath), { recursive: true, mode: 0o700 });
  const staged = `${releasePath}.staged-${process.pid}`;
  fs.rmSync(staged, { recursive: true, force: true });
  try {
    copyDistro(sourceRoot, staged);
    verifyDistro(staged, version);
    fs.renameSync(staged, releasePath);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  return { version, sourceRoot, releasePath, created: true, reused: false };
}

export function activateDistroRelease(ctx, options = {}) {
  const recoveredTransactions = options.dryRun ? [] : recoverPendingFileTransactions(ctx);
  const staged = stageDistroRelease(ctx, options);
  const recoveredPending = options.dryRun ? null : recoverLegacyPendingActivation(ctx);
  const previous = readCurrentRelease(ctx);
  const sameAsCurrent = Boolean(
    previous?.releasePath && path.resolve(previous.releasePath) === path.resolve(staged.releasePath),
  );
  const rollbackVersion = sameAsCurrent ? previous?.previousVersion || "" : previous?.version || "";
  const rollbackReleasePath = sameAsCurrent ? previous?.previousReleasePath || "" : previous?.releasePath || "";
  const result = {
    schema: JOURNAL_SCHEMA,
    createdAt: new Date().toISOString(),
    operation: options.operation || "activate",
    dryRun: Boolean(options.dryRun),
    version: staged.version,
    releasePath: staged.releasePath,
    previousVersion: rollbackVersion,
    previousReleasePath: rollbackReleasePath,
    agentDir: ctx.agentDir,
    copied: [],
    removed: [],
    noOp: false,
    recoveredPending: recoveredPending || null,
    recoveredTransactions,
  };
  if (options.dryRun) return result;
  const forceActivation = Boolean(options.force || /repair/.test(result.operation));
  if (!forceActivation && sameAsCurrent) {
    return { ...result, noOp: true };
  }

  fs.mkdirSync(ctx.agentDir, { recursive: true });
  const currentFiles = releaseOwnedFiles(staged.releasePath);
  const previousFiles = previous?.releasePath && fs.existsSync(previous.releasePath)
    ? releaseOwnedFiles(previous.releasePath)
    : [];
  const currentSet = new Set(currentFiles);
  const removed = previousFiles.filter((rel) => {
    if (currentSet.has(rel) || !isReleaseOwnedActivePath(rel)) return false;
    return fs.existsSync(path.join(ctx.agentDir, rel));
  });
  const journalPath = releaseJournalPath(ctx, result.operation);
  const completed = {
    ...result,
    copied: [...currentFiles],
    removed,
    status: "completed",
    journalPath,
  };
  const pointer = {
    schema: POINTER_SCHEMA,
    version: staged.version,
    releasePath: staged.releasePath,
    agentDir: ctx.agentDir,
    previousVersion: rollbackVersion,
    previousReleasePath: rollbackReleasePath,
    activatedAt: new Date().toISOString(),
    journalPath,
  };
  try {
    const mutations = [
      ...currentFiles.map((rel) => ({
        source: path.join(staged.releasePath, rel),
        target: path.join(ctx.agentDir, rel),
      })),
      ...removed.map((rel) => ({ target: path.join(ctx.agentDir, rel), remove: true })),
      { contents: `${JSON.stringify(completed, null, 2)}\n`, target: journalPath, mode: 0o600 },
      { contents: `${JSON.stringify(pointer, null, 2)}\n`, target: currentPointerPath(ctx), mode: 0o600 },
    ];
    const transaction = runFileTransaction(ctx, {
      operation: `release-${result.operation}`,
      mutations,
      faultAfter: options.faultAfter,
      afterMutation: options.afterMutation,
    });
    fs.rmSync(pendingActivationPath(ctx), { force: true });
    return { ...completed, transaction };
  } catch (error) {
    writeReleaseJournal(ctx, {
      ...result,
      status: "compensated",
      interruptedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    });
    throw error;
  }
}

export function rollbackDistroRelease(ctx, options = {}) {
  const current = readCurrentRelease(ctx);
  if (!current?.previousReleasePath || !fs.existsSync(current.previousReleasePath)) {
    throw new CliError("no previous immutable pi-67 release is available for rollback", 2);
  }
  return activateDistroRelease(ctx, {
    sourceRoot: current.previousReleasePath,
    dryRun: options.dryRun,
    operation: "rollback",
  });
}

export function inspectRuntimeMigration(ctx, options = {}) {
  const sourceRoot = resolveDistroSourceRoot(ctx, options);
  const current = readCurrentRelease(ctx);
  return {
    schema: "pi67.runtime-migration-check.v1",
    createdAt: new Date().toISOString(),
    agentDir: ctx.agentDir,
    stateDir: ctx.stateDir,
    sourceRoot,
    targetVersion: distroVersion(sourceRoot),
    agentExists: fs.existsSync(ctx.agentDir),
    legacyGitCheckout: fs.existsSync(path.join(ctx.agentDir, ".git")),
    activeRelease: current,
    required: fs.existsSync(path.join(ctx.agentDir, ".git")) || !current,
    preserves: [...PRESERVED_RUNTIME_FILES, ...MIGRATION_RUNTIME_DIRS],
  };
}

export function migrateRuntimeLayout(ctx, options = {}) {
  const recoveredMigration = options.dryRun ? null : recoverPendingRuntimeMigration(ctx);
  const check = inspectRuntimeMigration(ctx, options);
  if (options.dryRun) return { ...check, dryRun: true };
  if (!check.agentExists) {
    const activation = activateDistroRelease(ctx, {
      sourceRoot: check.sourceRoot,
      operation: "migrate-fresh",
    });
    return writeMigrationJournal(ctx, {
      operation: "migrate-fresh",
      sourceAgentDir: "",
      backupAgentDir: "",
      targetVersion: check.targetVersion,
      previousRelease: check.activeRelease,
      activation,
      status: "completed",
      recoveredMigration,
    });
  }
  if (!check.required) {
    return { schema: MIGRATION_SCHEMA, createdAt: new Date().toISOString(), status: "not-required", check };
  }

  const staged = stageDistroRelease(ctx, { sourceRoot: check.sourceRoot });
  const migrationId = `${timestamp()}-runtime-layout-${crypto.randomUUID()}`;
  const backupRoot = path.join(ctx.stateDir, "backups", migrationId);
  const backupAgentDir = path.join(backupRoot, "legacy-agent");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const baseJournal = {
    operation: "migrate-layout",
    sourceAgentDir: ctx.agentDir,
    backupAgentDir,
    targetVersion: staged.version,
    previousRelease: check.activeRelease,
    recoveredMigration,
  };
  writeMigrationJournal(ctx, { ...baseJournal, status: "prepared" }, migrationId);
  let legacyRenamed = false;
  try {
    fs.renameSync(ctx.agentDir, backupAgentDir);
    legacyRenamed = true;
    writeMigrationJournal(ctx, { ...baseJournal, status: "legacy-renamed" }, migrationId);
    if (typeof options.afterLegacyRename === "function") options.afterLegacyRename({ migrationId, backupAgentDir });
    fs.mkdirSync(ctx.agentDir, { recursive: true });
    activateDistroRelease(ctx, {
      sourceRoot: staged.releasePath,
      operation: "migrate-layout",
    });
    writeMigrationJournal(ctx, { ...baseJournal, status: "release-activated" }, migrationId);
    copyMigrationRuntime(backupAgentDir, ctx.agentDir);
    return writeMigrationJournal(ctx, {
      ...baseJournal,
      status: "completed",
    }, migrationId);
  } catch (error) {
    if (legacyRenamed) {
      fs.rmSync(ctx.agentDir, { recursive: true, force: true });
      if (fs.existsSync(backupAgentDir)) fs.renameSync(backupAgentDir, ctx.agentDir);
      restoreReleasePointer(ctx, check.activeRelease);
    }
    writeMigrationJournal(ctx, {
      ...baseJournal,
      status: "compensated",
      failedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    }, migrationId);
    throw error;
  }
}

export function rollbackRuntimeMigration(ctx, options = {}) {
  if (!options.dryRun) recoverPendingRuntimeMigration(ctx);
  const journal = latestMigrationJournal(ctx);
  if (!journal || journal.status !== "completed" || !journal.backupAgentDir) {
    throw new CliError("no completed runtime-layout migration is available for rollback", 2);
  }
  if (!fs.existsSync(journal.backupAgentDir)) {
    throw new CliError(`migration backup is missing: ${journal.backupAgentDir}`, 2);
  }
  const rollbackAgentDir = path.join(
    ctx.stateDir,
    "backups",
    `${timestamp()}-pre-migration-rollback-${crypto.randomUUID()}`,
    "agent",
  );
  if (options.dryRun) {
    return { schema: "pi67.runtime-migration-rollback.v1", dryRun: true, journal, rollbackAgentDir };
  }
  fs.mkdirSync(path.dirname(rollbackAgentDir), { recursive: true, mode: 0o700 });
  writeJsonAtomic(journal.path, withoutPath({
    ...journal,
    rollback: { status: "prepared", rollbackAgentDir, startedAt: new Date().toISOString() },
  }));
  try {
    fs.renameSync(ctx.agentDir, rollbackAgentDir);
    writeJsonAtomic(journal.path, withoutPath({
      ...journal,
      rollback: { status: "active-renamed", rollbackAgentDir, startedAt: new Date().toISOString() },
    }));
    fs.renameSync(journal.backupAgentDir, ctx.agentDir);
    writeJsonAtomic(journal.path, withoutPath({
      ...journal,
      rollback: { status: "filesystem-swapped", rollbackAgentDir, startedAt: new Date().toISOString() },
    }));
  } catch (error) {
    if (!fs.existsSync(ctx.agentDir) && fs.existsSync(rollbackAgentDir)) fs.renameSync(rollbackAgentDir, ctx.agentDir);
    writeJsonAtomic(journal.path, withoutPath({
      ...journal,
      rollback: {
        status: "compensated",
        rollbackAgentDir,
        failedAt: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 500),
      },
    }));
    throw error;
  }
  if (journal.previousRelease) writeJsonAtomic(currentPointerPath(ctx), journal.previousRelease);
  else fs.rmSync(currentPointerPath(ctx), { force: true });
  const updated = {
    ...journal,
    status: "rolled-back",
    rolledBackAt: new Date().toISOString(),
    rollbackAgentDir,
    rollback: { status: "completed", rollbackAgentDir },
  };
  writeJsonAtomic(journal.path, withoutPath(updated));
  return { schema: "pi67.runtime-migration-rollback.v1", dryRun: false, journal: updated };
}

export function recoverPendingRuntimeMigration(ctx) {
  const journal = latestMigrationJournal(ctx);
  if (!journal) return null;
  const rollbackStatus = journal.rollback?.status || "";
  if (["prepared", "active-renamed"].includes(rollbackStatus)) {
    compensateInterruptedMigrationRollback(ctx, journal);
    return { operation: journal.operation, recovery: "rollback-compensated", journalPath: journal.path };
  }
  if (rollbackStatus === "filesystem-swapped") {
    if (journal.previousRelease) writeJsonAtomic(currentPointerPath(ctx), journal.previousRelease);
    else fs.rmSync(currentPointerPath(ctx), { force: true });
    writeJsonAtomic(journal.path, withoutPath({
      ...journal,
      status: "rolled-back",
      rolledBackAt: new Date().toISOString(),
      rollback: { ...journal.rollback, status: "completed" },
    }));
    return { operation: journal.operation, recovery: "rollback-completed", journalPath: journal.path };
  }
  if (!["prepared", "legacy-renamed", "release-activated"].includes(journal.status)) return null;

  if (fs.existsSync(journal.backupAgentDir)) {
    fs.rmSync(ctx.agentDir, { recursive: true, force: true });
    fs.renameSync(journal.backupAgentDir, ctx.agentDir);
    restoreReleasePointer(ctx, journal.previousRelease || null);
  } else if (journal.status !== "prepared") {
    throw new CliError(`cannot recover interrupted runtime migration; legacy backup is missing: ${journal.backupAgentDir}`, 2);
  }
  writeJsonAtomic(journal.path, withoutPath({
    ...journal,
    status: "compensated",
    recoveredAt: new Date().toISOString(),
  }));
  return { operation: journal.operation, recovery: "migration-compensated", journalPath: journal.path };
}

function compensateInterruptedMigrationRollback(ctx, journal) {
  const rollbackAgentDir = journal.rollback?.rollbackAgentDir;
  if (!rollbackAgentDir || !fs.existsSync(rollbackAgentDir)) {
    if (journal.rollback?.status === "prepared" && fs.existsSync(ctx.agentDir)) {
      writeJsonAtomic(journal.path, withoutPath({
        ...journal,
        rollback: { ...journal.rollback, status: "compensated" },
      }));
      return;
    }
    throw new CliError("cannot recover interrupted migration rollback; active runtime backup is missing", 2);
  }
  if (fs.existsSync(ctx.agentDir) && !fs.existsSync(journal.backupAgentDir)) {
    fs.renameSync(ctx.agentDir, journal.backupAgentDir);
  } else {
    fs.rmSync(ctx.agentDir, { recursive: true, force: true });
  }
  fs.renameSync(rollbackAgentDir, ctx.agentDir);
  writeJsonAtomic(journal.path, withoutPath({
    ...journal,
    rollback: { ...journal.rollback, status: "compensated", recoveredAt: new Date().toISOString() },
  }));
}

function copyMigrationRuntime(sourceRoot, targetRoot) {
  for (const rel of PRESERVED_RUNTIME_FILES) {
    const source = path.join(sourceRoot, rel);
    if (!fs.existsSync(source)) continue;
    copyPath(source, path.join(targetRoot, rel));
  }
  for (const rel of MIGRATION_RUNTIME_DIRS) {
    const source = path.join(sourceRoot, rel);
    if (!fs.existsSync(source)) continue;
    copyPath(source, path.join(targetRoot, rel));
  }
}

function copyDistro(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const entry of distroTopLevelEntries(sourceRoot)) {
    copyPath(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name));
  }
}

function assertSameDistro(sourceRoot, releasePath) {
  if (path.resolve(sourceRoot) === path.resolve(releasePath)) return;
  const sourceFiles = distroFiles(sourceRoot);
  const releaseFiles = distroFiles(releasePath);
  if (sourceFiles.length !== releaseFiles.length) {
    throw new CliError(`immutable pi-67 release ${distroVersion(sourceRoot)} already exists with different content`, 2);
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const sourceRel = sourceFiles[index];
    const releaseRel = releaseFiles[index];
    if (sourceRel !== releaseRel || sha256(path.join(sourceRoot, sourceRel)) !== sha256(path.join(releasePath, releaseRel))) {
      throw new CliError(`immutable pi-67 release ${distroVersion(sourceRoot)} already exists with different content`, 2);
    }
  }
}

function distroFiles(root) {
  const files = [];
  for (const entry of distroTopLevelEntries(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, files);
    else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}

function distroTopLevelEntries(root) {
  const bundled = fs.existsSync(path.join(root, BUNDLE_MANIFEST));
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => {
    if (bundled) return entry.isDirectory() || entry.isFile();
    return entry.isDirectory() ? SOURCE_DISTRO_DIRS.has(entry.name) : SOURCE_DISTRO_FILES.has(entry.name);
  });
}

function verifyDistro(root, expectedVersion) {
  const actualVersion = distroVersion(root);
  if (actualVersion !== expectedVersion) {
    throw new CliError(`pi-67 release version mismatch: expected ${expectedVersion}, got ${actualVersion || "missing"}`, 2);
  }
  for (const rel of ["VERSION", "AGENTS.md", "scripts", "extensions", "shared-skills", "shared-skill-packs.json"]) {
    if (!fs.existsSync(path.join(root, rel))) throw new CliError(`pi-67 release asset is missing: ${rel}`, 2);
  }
  const manifest = readJsonFileIfExists(path.join(root, BUNDLE_MANIFEST));
  if (!manifest) return;
  if (manifest.schema !== BUNDLE_SCHEMA || manifest.version !== expectedVersion || !Array.isArray(manifest.files)) {
    throw new CliError(`invalid pi-67 distro bundle manifest: ${path.join(root, BUNDLE_MANIFEST)}`, 2);
  }
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    if (!fs.existsSync(file) || sha256(file) !== entry.sha256) {
      throw new CliError(`pi-67 distro bundle integrity mismatch: ${entry.path}`, 2);
    }
  }
}

function releaseOwnedFiles(root) {
  const files = [];
  walkFiles(root, root, files);
  return files.filter(isReleaseOwnedActivePath).sort();
}

function isReleaseOwnedActivePath(rel) {
  const normalized = rel.replace(/\\/g, "/");
  if (normalized === BUNDLE_MANIFEST || PRESERVED_RUNTIME_FILES.includes(normalized)) return false;
  return !ACTIVE_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function walkFiles(root, dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, files);
    else if (entry.isFile()) files.push(path.relative(root, full).replace(/\\/g, "/"));
  }
}

function realPathMaybe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function copyPath(source, target) {
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  } else {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o777);
  }
}

function distroVersion(root) {
  const version = readTextIfExists(path.join(root, "VERSION")).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new CliError(`invalid or missing pi-67 distro VERSION: ${path.join(root, "VERSION")}`, 2);
  }
  return version;
}

function hasDistro(root) {
  return Boolean(root) && fs.existsSync(path.join(root, "VERSION")) && fs.existsSync(path.join(root, "shared-skills"));
}

function currentPointerPath(ctx) {
  return path.join(ctx.stateDir, "current.json");
}

function restoreReleasePointer(ctx, previous) {
  if (previous) writeJsonAtomic(currentPointerPath(ctx), previous);
  else fs.rmSync(currentPointerPath(ctx), { force: true });
  fs.rmSync(pendingActivationPath(ctx), { force: true });
}

function pendingActivationPath(ctx) {
  return path.join(ctx.stateDir, PENDING_ACTIVATION);
}

function recoverLegacyPendingActivation(ctx) {
  const file = pendingActivationPath(ctx);
  const pending = readJsonFileIfExists(file);
  if (!pending) return null;
  if (pending.agentDir && realPathMaybe(pending.agentDir) !== realPathMaybe(ctx.agentDir)) {
    throw new CliError(`pending release activation belongs to another workspace: ${pending.agentDir}`, 2);
  }
  const current = readCurrentRelease(ctx);
  if (
    current?.releasePath && pending.releasePath &&
    path.resolve(current.releasePath) === path.resolve(pending.releasePath)
  ) {
    fs.rmSync(file, { force: true });
    return { ...pending, recovery: "cleared-after-pointer-commit" };
  }
  if (pending.previousReleasePath && fs.existsSync(pending.previousReleasePath)) {
    const previousFiles = releaseOwnedFiles(pending.previousReleasePath);
    const targetFiles = pending.releasePath && fs.existsSync(pending.releasePath)
      ? releaseOwnedFiles(pending.releasePath)
      : [];
    const previousSet = new Set(previousFiles);
    runFileTransaction(ctx, {
      operation: "recover-legacy-release-activation",
      mutations: [
        ...previousFiles.map((rel) => ({
          source: path.join(pending.previousReleasePath, rel),
          target: path.join(ctx.agentDir, rel),
        })),
        ...targetFiles
          .filter((rel) => !previousSet.has(rel))
          .map((rel) => ({ target: path.join(ctx.agentDir, rel), remove: true })),
      ],
    });
    fs.rmSync(file, { force: true });
    return { ...pending, recovery: "compensated-to-previous-release" };
  }
  return { ...pending, recovery: "resume-idempotently" };
}

function writeReleaseJournal(ctx, payload) {
  const file = releaseJournalPath(ctx, payload.operation);
  writeJsonAtomic(file, payload);
  return file;
}

function releaseJournalPath(ctx, operation) {
  return path.join(ctx.stateDir, "journals", `${timestamp()}-${operation}-${crypto.randomUUID()}.json`);
}

function writeMigrationJournal(ctx, payload, id = `${timestamp()}-runtime-layout`) {
  const file = path.join(ctx.stateDir, "migrations", `${id}.json`);
  const existing = readJsonFileIfExists(file);
  const now = new Date().toISOString();
  const journal = {
    schema: MIGRATION_SCHEMA,
    createdAt: existing?.createdAt || now,
    ...payload,
    updatedAt: now,
  };
  writeJsonAtomic(file, journal);
  return { ...journal, path: file };
}

function latestMigrationJournal(ctx) {
  const root = path.join(ctx.stateDir, "migrations");
  if (!fs.existsSync(root)) return null;
  const journals = [];
  for (const name of fs.readdirSync(root).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(root, name);
    let payload;
    try {
      payload = readJsonFileIfExists(file);
    } catch {
      throw new CliError(`could not read runtime migration journal: ${file}`, 2);
    }
    validateMigrationJournal(ctx, payload, file);
    journals.push({
      ...payload,
      path: file,
      sortTime: Date.parse(payload.updatedAt || payload.createdAt || "") || fs.statSync(file).mtimeMs,
    });
  }
  journals.sort((left, right) => right.sortTime - left.sortTime || right.path.localeCompare(left.path));
  if (journals.length === 0) return null;
  const { sortTime: _sortTime, ...latest } = journals[0];
  return latest;
}

function validateMigrationJournal(ctx, journal, file) {
  const invalid = (reason) => {
    throw new CliError(`invalid runtime migration journal (${reason}): ${file}`, 2);
  };
  if (!journal || journal.schema !== MIGRATION_SCHEMA) invalid("schema");
  if (!["migrate-layout", "migrate-fresh"].includes(journal.operation)) invalid("operation");
  if (![
    "prepared",
    "legacy-renamed",
    "release-activated",
    "completed",
    "compensated",
    "rolled-back",
  ].includes(journal.status)) invalid("status");
  if (!journal.createdAt || !journal.updatedAt) invalid("timestamps");

  if (journal.operation === "migrate-fresh") {
    if (journal.sourceAgentDir || journal.backupAgentDir) invalid("fresh migration paths");
  } else {
    if (canonicalPathIdentity(journal.sourceAgentDir) !== canonicalPathIdentity(ctx.agentDir)) {
      invalid("workspace binding");
    }
    validateMigrationBackupPath(ctx, journal.backupAgentDir, "legacy backup", invalid);
  }

  const rollbackAgentDir = journal.rollback?.rollbackAgentDir || journal.rollbackAgentDir || "";
  if (rollbackAgentDir) validateMigrationBackupPath(ctx, rollbackAgentDir, "rollback backup", invalid);
  if (journal.rollback && !["prepared", "active-renamed", "filesystem-swapped", "completed", "compensated"].includes(journal.rollback.status)) {
    invalid("rollback status");
  }
  validateMigrationReleasePointer(ctx, journal.previousRelease, invalid);
}

function validateMigrationBackupPath(ctx, candidate, label, invalid) {
  const backupRoot = path.join(ctx.stateDir, "backups");
  if (!candidate || !isPathStrictlyWithin(backupRoot, candidate)) invalid(`${label} path`);
}

function validateMigrationReleasePointer(ctx, pointer, invalid) {
  if (!pointer) return;
  if (pointer.schema !== POINTER_SCHEMA || !pointer.version || !pointer.releasePath) invalid("previous release pointer");
  if (canonicalPathIdentity(pointer.agentDir || defaultAgentDir()) !== canonicalPathIdentity(ctx.agentDir)) {
    invalid("previous release workspace binding");
  }
  const releasesRoot = path.join(ctx.stateDir, "releases");
  for (const candidate of [pointer.releasePath, pointer.previousReleasePath].filter(Boolean)) {
    if (!isPathStrictlyWithin(releasesRoot, candidate)) invalid("previous release path");
  }
}

function withoutPath(value) {
  const { path: _path, ...rest } = value;
  return rest;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
