import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./output.mjs";

const LOCK_STALE_AFTER_MS = 4 * 60 * 60 * 1000;
const INCOMPLETE_LOCK_GRACE_MS = 30 * 1000;

export function acquireSkillDeployLock(ctx, operation) {
  const lockPath = path.join(ctx.stateDir, "locks", "skills-deploy.lock");
  const ownerId = crypto.randomUUID();
  const payload = {
    schema: "pi67.skill-deploy-lock.v1",
    ownerId,
    pid: process.pid,
    hostname: os.hostname(),
    operation,
    skillsDir: path.resolve(ctx.skillsDir),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  acquire(lockPath, payload);
  let released = false;
  return {
    path: lockPath,
    ownerId,
    release() {
      if (released) return;
      release(lockPath, ownerId);
      released = true;
    },
  };
}

export function withSkillDeployLock(ctx, operation, callback) {
  const lock = acquireSkillDeployLock(ctx, operation);
  try {
    return callback(lock);
  } finally {
    lock.release();
  }
}

function acquire(lockPath, payload, staleRecoveryAttempts = 0) {
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = inspectLock(lockPath);
    if (existing.stale) {
      if (staleRecoveryAttempts >= 3) {
        throw new CliError(`could not acquire Skill deploy lock after repeated stale-lock recovery: ${lockPath}`, 1);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
      return acquire(lockPath, payload, staleRecoveryAttempts + 1);
    }
    const owner = existing.payload
      ? `operation=${existing.payload.operation || "unknown"}, pid=${existing.payload.pid || "unknown"}`
      : "owner metadata is still being written";
    throw new CliError(`another pi-67 Skill deployment appears to be running (${owner}); lock exists: ${lockPath}`, 1);
  }
}

function release(lockPath, ownerId) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new CliError(`could not verify Skill deploy lock ownership before release: ${lockPath}`, 1);
  }
  if (payload.ownerId !== ownerId) {
    throw new CliError(`Skill deploy lock ownership changed; refusing to remove another process lock: ${lockPath}`, 1);
  }
  fs.unlinkSync(lockPath);
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
    payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return { stale: ageMs > INCOMPLETE_LOCK_GRACE_MS, payload: null };
  }
  if (
    payload?.schema !== "pi67.skill-deploy-lock.v1"
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
