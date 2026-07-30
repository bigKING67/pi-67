import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalPathIdentity,
  recoverPendingFileTransactions,
  workspaceResource,
} from "./file-transaction.mjs";
import { CliError } from "./output.mjs";
import { recoverPendingRuntimeMigration } from "./release-store.mjs";

const LOCK_STALE_AFTER_MS = 4 * 60 * 60 * 1000;
const INCOMPLETE_LOCK_GRACE_MS = 30 * 1000;

export function beginWorkspaceOperation(ctx, options = {}) {
  const operation = options.operation || "workspace-write";
  const dryRun = Boolean(options.dryRun);
  const resource = workspaceResource(ctx);
  const agentDirIdentity = resource.agentDir;
  const lockPath = path.join(resource.stateRoot, "locks", `workspace-operation-${resource.resourceId}.lock`);
  const legacyLockPath = path.join(ctx.stateDir, "locks", "update.lock");
  if (dryRun) {
    return { lockPath, legacyLockPath, ownerId: "", release() {} };
  }

  const ownerId = crypto.randomUUID();
  const payload = {
    schema: "pi67.workspace-operation-lock.v1",
    ownerId,
    pid: process.pid,
    hostname: os.hostname(),
    agentDir: agentDirIdentity,
    operation,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  acquire(lockPath, payload);
  try {
    acquireLegacyLock(legacyLockPath, payload);
  } catch (error) {
    release(lockPath, ownerId);
    throw error;
  }
  let recoveredTransactions;
  let recoveredMigration;
  try {
    recoveredTransactions = recoverPendingFileTransactions(ctx);
    recoveredMigration = recoverPendingRuntimeMigration(ctx);
  } catch (error) {
    releaseBoth(lockPath, legacyLockPath, ownerId);
    throw error;
  }
  let released = false;
  return {
    lockPath,
    legacyLockPath,
    ownerId,
    recoveredTransactions,
    recoveredMigration,
    release() {
      if (released) return;
      releaseBoth(lockPath, legacyLockPath, ownerId);
      released = true;
    },
  };
}

function acquireLegacyLock(lockPath, payload, staleRecoveryAttempts = 0) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const legacyPayload = { ...payload, schema: "pi67.update-lock.v1" };
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(legacyPayload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const existing = inspectLegacyLock(lockPath);
  if (!existing.stale) {
    const owner = existing.payload
      ? `operation=${existing.payload.operation || "unknown"}, pid=${existing.payload.pid || "unknown"}`
      : "owner metadata is still being written";
    throw new CliError(`another pi-67 operation appears to be running through the legacy update lock (${owner}); lock exists: ${lockPath}`, 1);
  }
  if (staleRecoveryAttempts >= 3) {
    throw new CliError(`could not acquire legacy update lock after repeated stale-lock recovery: ${lockPath}`, 1);
  }
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code || "")) throw error;
    return acquireLegacyLock(lockPath, payload, staleRecoveryAttempts + 1);
  }
  fs.rmSync(quarantine, { force: true });
  return acquireLegacyLock(lockPath, payload, staleRecoveryAttempts + 1);
}

function inspectLegacyLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { stale: true, payload: null };
    throw error;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return { stale: ageMs > INCOMPLETE_LOCK_GRACE_MS, payload: null };
  }
  if (!Number.isInteger(payload?.pid) || payload.pid < 1) {
    return { stale: ageMs > INCOMPLETE_LOCK_GRACE_MS, payload };
  }
  return { stale: !processExists(payload.pid), payload };
}

function releaseBoth(lockPath, legacyLockPath, ownerId) {
  try {
    releaseLegacyLock(legacyLockPath, ownerId);
  } finally {
    release(lockPath, ownerId);
  }
}

function releaseLegacyLock(lockPath, ownerId) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new CliError(`could not verify legacy update lock ownership before release: ${lockPath}`, 1);
  }
  if (payload.ownerId !== ownerId) {
    throw new CliError(`legacy update lock ownership changed; refusing to remove another process lock: ${lockPath}`, 1);
  }
  fs.unlinkSync(lockPath);
}

function acquire(lockPath, payload, staleRecoveryAttempts = 0) {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(payload, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = inspectLock(lockPath);
  if (!existing.stale) {
    const owner = existing.payload
      ? `operation=${existing.payload.operation || "unknown"}, pid=${existing.payload.pid || "unknown"}`
      : "owner metadata is still being written";
    throw new CliError(`another pi-67 workspace operation appears to be running (${owner}); lock exists: ${lockPath}`, 1);
  }
  if (staleRecoveryAttempts >= 3) {
    throw new CliError(`could not acquire workspace operation lock after repeated stale-lock recovery: ${lockPath}`, 1);
  }

  // Renaming the lock directory is the ownership transfer. A competing process
  // can only move the stale directory once and cannot delete a replacement lock.
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code || "")) throw error;
    return acquire(lockPath, payload, staleRecoveryAttempts + 1);
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return acquire(lockPath, payload, staleRecoveryAttempts + 1);
}

function release(lockPath, ownerId) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new CliError(`could not verify workspace operation lock ownership before release: ${lockPath}`, 1);
  }
  if (payload.ownerId !== ownerId) {
    throw new CliError(`workspace operation lock ownership changed; refusing to remove another process lock: ${lockPath}`, 1);
  }
  fs.rmSync(lockPath, { recursive: true });
}

function inspectLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return { stale: true, payload: null };
    throw error;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return { stale: ageMs > INCOMPLETE_LOCK_GRACE_MS, payload: null };
  }
  if (
    payload?.schema !== "pi67.workspace-operation-lock.v1"
    || typeof payload.ownerId !== "string"
    || !payload.ownerId
    || !Number.isInteger(payload.pid)
    || payload.pid < 1
  ) {
    return { stale: ageMs > INCOMPLETE_LOCK_GRACE_MS, payload };
  }
  if (payload.hostname && payload.hostname !== os.hostname()) {
    return { stale: ageMs > LOCK_STALE_AFTER_MS, payload };
  }
  return { stale: !processExists(payload.pid), payload };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
