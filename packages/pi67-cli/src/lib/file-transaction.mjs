import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./config-json.mjs";
import { CliError } from "./output.mjs";

const TRANSACTION_SCHEMA = "pi67.file-transaction.v1";

export function recoverPendingFileTransactions(ctx) {
  const root = transactionsRoot(ctx);
  if (!fs.existsSync(root)) return [];
  const recovered = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const transactionDir = path.join(root, entry.name);
    const journal = readJournal(transactionDir);
    if (!journal) {
      // Live targets are not touched until the initial prepared journal exists.
      fs.rmSync(transactionDir, { recursive: true, force: true });
      continue;
    }
    validateRecoveryJournal(ctx, transactionDir, journal);
    if (journal.status === "completed" || journal.status === "compensated") {
      fs.rmSync(transactionDir, { recursive: true, force: true });
      continue;
    }
    compensate(transactionDir, journal);
    recovered.push({ id: journal.id, operation: journal.operation, recovery: "compensated" });
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
  return recovered;
}

export function runFileTransaction(ctx, options) {
  const mutations = Array.isArray(options?.mutations) ? options.mutations : [];
  if (mutations.length === 0) {
    return { id: "", operation: options?.operation || "file-write", changed: 0, recovered: [] };
  }
  const recovered = recoverPendingFileTransactions(ctx);
  const id = `${timestamp()}-${process.pid}-${crypto.randomUUID()}`;
  const transactionDir = path.join(transactionsRoot(ctx), id);
  const stagedDir = path.join(transactionDir, "staged");
  const rollbackDir = path.join(transactionDir, "rollback");
  fs.mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rollbackDir, { recursive: true, mode: 0o700 });

  const seenTargets = new Set();
  let prepared;
  try {
    prepared = mutations.map((mutation, index) => {
      const rawTarget = String(mutation.target || "").trim();
      if (!rawTarget) throw new CliError("file transaction target is required", 2);
      const target = path.resolve(rawTarget);
      assertTransactionTargetWithinWorkspace(ctx, target);
      const targetIdentity = canonicalPathIdentity(target);
      if (seenTargets.has(targetIdentity)) {
        throw new CliError(`duplicate file transaction target: ${target}`, 2);
      }
      seenTargets.add(targetIdentity);
      const rollback = snapshotTarget(target, rollbackDir, index);
      const staged = mutation.source
        ? stageSource(mutation.source, stagedDir, index)
        : (Object.hasOwn(mutation, "contents")
            ? stageContents(mutation.contents, stagedDir, index, mutation.mode)
            : null);
      if (!staged && mutation.remove !== true) {
        throw new CliError(`file transaction mutation requires source or remove=true: ${target}`, 2);
      }
      return {
        target,
        mode: Number.isInteger(mutation.mode) ? mutation.mode : null,
        staged,
        rollback,
      };
    });
  } catch (error) {
    fs.rmSync(transactionDir, { recursive: true, force: true });
    throw error;
  }
  let journal = {
    schema: TRANSACTION_SCHEMA,
    id,
    operation: options.operation || "file-write",
    agentDir: canonicalPathIdentity(ctx.agentDir),
    stateDir: path.resolve(ctx.stateDir),
    createdAt: new Date().toISOString(),
    status: "prepared",
    applied: 0,
    mutations: prepared,
  };
  try {
    writeJournal(transactionDir, journal);
  } catch (error) {
    fs.rmSync(transactionDir, { recursive: true, force: true });
    throw error;
  }

  try {
    journal = { ...journal, status: "applying" };
    writeJournal(transactionDir, journal);
    for (let index = 0; index < prepared.length; index += 1) {
      applyMutation(prepared[index]);
      journal = { ...journal, applied: index + 1, updatedAt: new Date().toISOString() };
      writeJournal(transactionDir, journal);
      if (typeof options.afterMutation === "function") options.afterMutation(journal.applied, journal);
      if (Number.isInteger(options.faultAfter) && journal.applied === options.faultAfter) {
        throw new Error(`injected file transaction failure after ${journal.applied} mutation(s)`);
      }
    }
    journal = { ...journal, status: "completed", completedAt: new Date().toISOString() };
    writeJournal(transactionDir, journal);
    fs.rmSync(transactionDir, { recursive: true, force: true });
    return { id, operation: journal.operation, changed: prepared.length, recovered };
  } catch (error) {
    journal = {
      ...journal,
      status: "compensating",
      failedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    };
    writeJournal(transactionDir, journal);
    try {
      compensate(transactionDir, journal);
      fs.rmSync(transactionDir, { recursive: true, force: true });
    } catch (compensationError) {
      writeJournal(transactionDir, {
        ...journal,
        status: "compensation-failed",
        compensationError: String(compensationError?.message || compensationError).slice(0, 500),
      });
      throw new CliError(
        `file transaction failed and automatic compensation also failed: ${error?.message || error}; compensation: ${compensationError?.message || compensationError}`,
        2,
      );
    }
    throw error;
  }
}

export function canonicalPathIdentity(input) {
  let candidate = path.resolve(String(input || ""));
  const missing = [];
  while (!lstatMaybe(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    missing.unshift(path.basename(candidate));
    candidate = parent;
  }
  try {
    candidate = fs.realpathSync.native(candidate);
  } catch {
    candidate = path.resolve(candidate);
  }
  const resolved = path.join(candidate, ...missing);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspaceResource(ctx) {
  const stateDir = path.resolve(ctx.stateDir);
  const parent = path.dirname(stateDir);
  const stateRoot = path.basename(parent) === "workspaces" ? path.dirname(parent) : stateDir;
  const agentDir = canonicalPathIdentity(ctx.agentDir);
  const resourceId = crypto.createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
  return { agentDir, resourceId, stateRoot };
}

function snapshotTarget(target, rollbackDir, index) {
  const stat = lstatMaybe(target);
  if (!stat) return { kind: "missing", path: "" };
  const snapshot = path.join(rollbackDir, String(index));
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", path: "", link: fs.readlinkSync(target) };
  }
  if (stat.isDirectory()) {
    fs.cpSync(target, snapshot, { recursive: true, dereference: false, errorOnExist: true });
    return { kind: "directory", path: snapshot };
  }
  if (!stat.isFile()) throw new CliError(`unsupported transaction target type: ${target}`, 2);
  fs.copyFileSync(target, snapshot);
  return { kind: "file", path: snapshot, mode: stat.mode & 0o777 };
}

function stageSource(source, stagedDir, index) {
  const resolved = path.resolve(String(source));
  const stat = fs.lstatSync(resolved);
  const staged = path.join(stagedDir, String(index));
  if (stat.isSymbolicLink()) {
    return { path: "", kind: "symlink", link: fs.readlinkSync(resolved), mode: null };
  }
  if (stat.isDirectory()) {
    fs.cpSync(resolved, staged, { recursive: true, dereference: false, errorOnExist: true });
    return { path: staged, kind: "directory", mode: stat.mode & 0o777 };
  }
  if (!stat.isFile()) throw new CliError(`unsupported file transaction source type: ${resolved}`, 2);
  fs.copyFileSync(resolved, staged);
  fs.chmodSync(staged, stat.mode & 0o777);
  return { path: staged, kind: "file", mode: stat.mode & 0o777 };
}

function stageContents(contents, stagedDir, index, mode) {
  const staged = path.join(stagedDir, String(index));
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  fs.writeFileSync(staged, bytes, { mode: Number.isInteger(mode) ? mode : 0o600 });
  return { path: staged, kind: "file", mode: Number.isInteger(mode) ? mode : 0o600 };
}

function applyMutation(mutation) {
  if (!mutation.staged) {
    removeTarget(mutation.target);
    return;
  }
  fs.mkdirSync(path.dirname(mutation.target), { recursive: true });
  if (mutation.staged.kind === "symlink") {
    removeTarget(mutation.target);
    fs.symlinkSync(mutation.staged.link, mutation.target);
    return;
  }
  const tmp = path.join(
    path.dirname(mutation.target),
    `.${path.basename(mutation.target)}.${process.pid}.${crypto.randomUUID()}.transaction-tmp`,
  );
  try {
    if (mutation.staged.kind === "directory") {
      fs.cpSync(mutation.staged.path, tmp, { recursive: true, dereference: false, errorOnExist: true });
    } else {
      fs.copyFileSync(mutation.staged.path, tmp);
      fs.chmodSync(tmp, mutation.mode ?? mutation.staged.mode ?? 0o600);
    }
    removeTarget(mutation.target);
    fs.renameSync(tmp, mutation.target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function compensate(transactionDir, journal) {
  const mutations = Array.isArray(journal.mutations) ? journal.mutations : [];
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    restoreSnapshot(mutations[index]);
  }
  writeJournal(transactionDir, {
    ...journal,
    status: "compensated",
    compensatedAt: new Date().toISOString(),
  });
}

function restoreSnapshot(mutation) {
  removeTarget(mutation.target);
  const snapshot = mutation.rollback || { kind: "missing" };
  if (snapshot.kind === "missing") return;
  fs.mkdirSync(path.dirname(mutation.target), { recursive: true });
  if (snapshot.kind === "symlink") {
    fs.symlinkSync(snapshot.link, mutation.target);
    return;
  }
  if (snapshot.kind === "directory") {
    fs.cpSync(snapshot.path, mutation.target, { recursive: true, dereference: false, errorOnExist: true });
    return;
  }
  if (snapshot.kind === "file") {
    fs.copyFileSync(snapshot.path, mutation.target);
    fs.chmodSync(mutation.target, snapshot.mode ?? 0o600);
    return;
  }
  throw new CliError(`unsupported rollback snapshot kind: ${snapshot.kind}`, 2);
}

function removeTarget(target) {
  const stat = lstatMaybe(target);
  if (!stat) return;
  fs.rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}

function lstatMaybe(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJournal(transactionDir, journal) {
  writeJsonAtomic(path.join(transactionDir, "journal.json"), journal);
}

function readJournal(transactionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(transactionDir, "journal.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CliError(`could not read pending file transaction journal: ${transactionDir}`, 2);
  }
}

function validateRecoveryJournal(ctx, transactionDir, journal) {
  if (journal.schema !== TRANSACTION_SCHEMA || !Array.isArray(journal.mutations)) {
    throw new CliError(`invalid pending file transaction journal: ${transactionDir}`, 2);
  }
  if (canonicalPathIdentity(journal.agentDir) !== canonicalPathIdentity(ctx.agentDir)) {
    throw new CliError(`pending file transaction belongs to another workspace: ${journal.agentDir || "missing"}`, 2);
  }
  if (!journal.stateDir) {
    throw new CliError(`pending file transaction is missing its state directory binding: ${transactionDir}`, 2);
  }
  const currentResource = workspaceResource(ctx);
  const journalResource = workspaceResource({ agentDir: journal.agentDir, stateDir: journal.stateDir });
  if (
    currentResource.resourceId !== journalResource.resourceId
    || canonicalPathIdentity(currentResource.stateRoot) !== canonicalPathIdentity(journalResource.stateRoot)
  ) {
    throw new CliError(`pending file transaction state binding does not match the current workspace: ${transactionDir}`, 2);
  }

  const stagedRoot = path.join(transactionDir, "staged");
  const rollbackRoot = path.join(transactionDir, "rollback");
  for (const mutation of journal.mutations) {
    assertTransactionTargetWithinWorkspace(ctx, mutation.target, "pending file transaction");
    validateTransactionArtifactPath(mutation.staged, stagedRoot, "staged");
    validateTransactionArtifactPath(mutation.rollback, rollbackRoot, "rollback");
  }
}

function assertTransactionTargetWithinWorkspace(ctx, target, label = "file transaction") {
  if (
    !isPathStrictlyWithin(ctx.agentDir, target)
    && !isPathStrictlyWithin(ctx.stateDir, target)
  ) {
    throw new CliError(`${label} target escapes its workspace: ${target || "missing"}`, 2);
  }
}

function validateTransactionArtifactPath(artifact, expectedRoot, label) {
  if (!artifact && label === "staged") return;
  if (!artifact || typeof artifact.kind !== "string") {
    throw new CliError(`pending file transaction has invalid ${label} metadata`, 2);
  }
  if (["missing", "symlink"].includes(artifact.kind)) {
    if (artifact.path) throw new CliError(`pending file transaction ${label} path is invalid`, 2);
    return;
  }
  if (!["file", "directory"].includes(artifact.kind) || !isPathStrictlyWithin(expectedRoot, artifact.path)) {
    throw new CliError(`pending file transaction ${label} path escapes its transaction directory`, 2);
  }
}

export function isPathStrictlyWithin(root, candidate) {
  if (!root || !candidate) return false;
  const relative = path.relative(canonicalPathIdentity(root), canonicalPathIdentity(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function transactionsRoot(ctx) {
  const resource = workspaceResource(ctx);
  return path.join(resource.stateRoot, "transactions", resource.resourceId);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
