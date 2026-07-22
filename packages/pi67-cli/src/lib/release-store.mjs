import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import { CliError } from "./output.mjs";
import { defaultAgentDir, packageRoot, readTextIfExists } from "./paths.mjs";
import { PRESERVED_RUNTIME_FILES } from "./update-safety.mjs";

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

const SOURCE_DISTRO_FILES = new Set([
  ".gitattributes", ".gitignore", "AGENTS.md", "CHANGELOG.md", "LICENSE", "README.md", "VERSION",
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
  const staged = stageDistroRelease(ctx, options);
  const recoveredPending = recoverCompletedPendingActivation(ctx);
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
  const pendingPath = pendingActivationPath(ctx);
  writeJsonAtomic(pendingPath, { ...result, status: "in-progress" });
  try {
    for (const rel of currentFiles) {
      copyFileAtomic(path.join(staged.releasePath, rel), path.join(ctx.agentDir, rel));
      result.copied.push(rel);
    }
    for (const rel of previousFiles) {
      if (currentSet.has(rel) || !isReleaseOwnedActivePath(rel)) continue;
      const target = path.join(ctx.agentDir, rel);
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { force: true });
      result.removed.push(rel);
    }

    const completed = { ...result, status: "completed" };
    const journalPath = writeReleaseJournal(ctx, completed);
    writeJsonAtomic(currentPointerPath(ctx), {
      schema: POINTER_SCHEMA,
      version: staged.version,
      releasePath: staged.releasePath,
      agentDir: ctx.agentDir,
      previousVersion: rollbackVersion,
      previousReleasePath: rollbackReleasePath,
      activatedAt: new Date().toISOString(),
      journalPath,
    });
    fs.rmSync(pendingPath, { force: true });
    return { ...completed, journalPath };
  } catch (error) {
    writeJsonAtomic(pendingPath, {
      ...result,
      status: "interrupted",
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
    });
  }
  if (!check.required) {
    return { schema: MIGRATION_SCHEMA, createdAt: new Date().toISOString(), status: "not-required", check };
  }

  const staged = stageDistroRelease(ctx, { sourceRoot: check.sourceRoot });
  const migrationId = `${timestamp()}-runtime-layout`;
  const backupRoot = path.join(ctx.stateDir, "backups", migrationId);
  const backupAgentDir = path.join(backupRoot, "legacy-agent");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.renameSync(ctx.agentDir, backupAgentDir);
  try {
    fs.mkdirSync(ctx.agentDir, { recursive: true });
    activateDistroRelease(ctx, {
      sourceRoot: staged.releasePath,
      operation: "migrate-layout",
    });
    copyMigrationRuntime(backupAgentDir, ctx.agentDir);
    return writeMigrationJournal(ctx, {
      operation: "migrate-layout",
      sourceAgentDir: ctx.agentDir,
      backupAgentDir,
      targetVersion: staged.version,
      previousRelease: check.activeRelease,
      status: "completed",
    }, migrationId);
  } catch (error) {
    fs.rmSync(ctx.agentDir, { recursive: true, force: true });
    fs.renameSync(backupAgentDir, ctx.agentDir);
    restoreReleasePointer(ctx, check.activeRelease);
    throw error;
  }
}

export function rollbackRuntimeMigration(ctx, options = {}) {
  const journal = latestMigrationJournal(ctx);
  if (!journal || journal.status !== "completed" || !journal.backupAgentDir) {
    throw new CliError("no completed runtime-layout migration is available for rollback", 2);
  }
  if (!fs.existsSync(journal.backupAgentDir)) {
    throw new CliError(`migration backup is missing: ${journal.backupAgentDir}`, 2);
  }
  const rollbackAgentDir = path.join(ctx.stateDir, "backups", `${timestamp()}-pre-migration-rollback`, "agent");
  if (options.dryRun) {
    return { schema: "pi67.runtime-migration-rollback.v1", dryRun: true, journal, rollbackAgentDir };
  }
  fs.mkdirSync(path.dirname(rollbackAgentDir), { recursive: true, mode: 0o700 });
  fs.renameSync(ctx.agentDir, rollbackAgentDir);
  try {
    fs.renameSync(journal.backupAgentDir, ctx.agentDir);
  } catch (error) {
    fs.renameSync(rollbackAgentDir, ctx.agentDir);
    throw error;
  }
  const updated = { ...journal, status: "rolled-back", rolledBackAt: new Date().toISOString(), rollbackAgentDir };
  writeJsonAtomic(journal.path, withoutPath(updated));
  if (journal.previousRelease) writeJsonAtomic(currentPointerPath(ctx), journal.previousRelease);
  else fs.rmSync(currentPointerPath(ctx), { force: true });
  return { schema: "pi67.runtime-migration-rollback.v1", dryRun: false, journal: updated };
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

function copyFileAtomic(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.copyFileSync(source, tmp);
  fs.chmodSync(tmp, fs.statSync(source).mode & 0o777);
  fs.renameSync(tmp, target);
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

function recoverCompletedPendingActivation(ctx) {
  const file = pendingActivationPath(ctx);
  const pending = readJsonFileIfExists(file);
  if (!pending) return null;
  const current = readCurrentRelease(ctx);
  if (
    current?.releasePath && pending.releasePath &&
    path.resolve(current.releasePath) === path.resolve(pending.releasePath)
  ) {
    fs.rmSync(file, { force: true });
    return { ...pending, recovery: "cleared-after-pointer-commit" };
  }
  return { ...pending, recovery: "resume-idempotently" };
}

function writeReleaseJournal(ctx, payload) {
  const file = path.join(ctx.stateDir, "journals", `${timestamp()}-${payload.operation}.json`);
  writeJsonAtomic(file, payload);
  return file;
}

function writeMigrationJournal(ctx, payload, id = `${timestamp()}-runtime-layout`) {
  const file = path.join(ctx.stateDir, "migrations", `${id}.json`);
  const journal = { schema: MIGRATION_SCHEMA, createdAt: new Date().toISOString(), ...payload };
  writeJsonAtomic(file, journal);
  return { ...journal, path: file };
}

function latestMigrationJournal(ctx) {
  const root = path.join(ctx.stateDir, "migrations");
  if (!fs.existsSync(root)) return null;
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const name of files) {
    const file = path.join(root, name);
    const payload = readJsonFileIfExists(file);
    if (payload?.schema === MIGRATION_SCHEMA) return { ...payload, path: file };
  }
  return null;
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
