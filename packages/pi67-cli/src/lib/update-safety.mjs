import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { CliError, info } from "./output.mjs";

export const PRESERVED_RUNTIME_FILES = [
  "settings.json",
  "models.json",
  "auth.json",
  "mcp.json",
  "image-gen.json",
  "settings.json.theme",
];

const LOCK_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export function beginUpdateLifecycle(ctx, options = {}) {
  const operation = options.operation || "update";
  const dryRun = Boolean(options.dryRun);
  const lockPath = path.join(ctx.stateDir, "locks", "update.lock");
  const backupDir = path.join(ctx.stateDir, "backups", `${timestamp()}-${operation}`);

  if (dryRun) {
    info(`DRY-RUN would acquire update lock: ${lockPath}`);
    info(`DRY-RUN would snapshot preserved runtime files into: ${backupDir}`);
    return {
      lockPath,
      backupDir,
      backedUp: [],
      release() {},
    };
  }

  acquireLock(lockPath, { operation });
  let released = false;
  try {
    const backedUp = createRuntimeBackup(ctx, backupDir, {
      operation,
      plan: options.plan,
    });
    return {
      lockPath,
      backupDir,
      backedUp,
      release() {
        if (released) return;
        released = true;
        releaseLock(lockPath);
      },
    };
  } catch (error) {
    releaseLock(lockPath);
    throw error;
  }
}

export function createRuntimeBackup(ctx, backupDir, options = {}) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const filesDir = path.join(backupDir, "files");
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  const preserved = [];
  const backedUp = [];
  for (const rel of PRESERVED_RUNTIME_FILES) {
    const source = path.join(ctx.agentDir, rel);
    if (!fs.existsSync(source)) {
      preserved.push({
        path: rel,
        exists: false,
      });
      continue;
    }
    const target = path.join(filesDir, rel.replace(/[\\/]/g, "__"));
    fs.copyFileSync(source, target);
    chmodPrivate(target);
    const item = {
      path: rel,
      exists: true,
      bytes: fs.statSync(source).size,
      sha256: sha256File(source),
    };
    preserved.push(item);
    backedUp.push(item);
  }

  if (options.plan) {
    fs.writeFileSync(
      path.join(backupDir, "update-plan.json"),
      `${JSON.stringify(options.plan, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  fs.writeFileSync(
    path.join(backupDir, "backup-manifest.json"),
    `${JSON.stringify({
      schema: "pi67.update-backup.v1",
      createdAt: new Date().toISOString(),
      operation: options.operation || "update",
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      files: preserved,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return backedUp;
}

export function listRuntimeBackups(ctx) {
  const backupsDir = path.join(ctx.stateDir, "backups");
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => backupSummary(path.join(backupsDir, entry.name)))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
}

export function inspectRuntimeBackup(ctx, input) {
  const backupDir = resolveBackupDir(ctx, input);
  const summary = backupSummary(backupDir);
  if (!summary) {
    throw new CliError(`backup manifest not found or unreadable: ${backupDir}`);
  }
  return summary;
}

export function restoreRuntimeBackup(ctx, input, options = {}) {
  const backup = inspectRuntimeBackup(ctx, input);
  const dryRun = Boolean(options.dryRun);
  const preRestoreBackupDir = path.join(ctx.stateDir, "backups", `${timestamp()}-pre-restore`);
  const preRestoreBackedUp = dryRun
    ? []
    : createRuntimeBackup(ctx, preRestoreBackupDir, { operation: "pre-restore" });
  const restored = [];
  const removed = [];
  const missing = [];
  const skipped = [];

  for (const item of backup.files) {
    const rel = String(item.path || "").replace(/\\/g, "/");
    if (!PRESERVED_RUNTIME_FILES.includes(rel)) {
      skipped.push({ path: rel, reason: "not a preserved runtime file" });
      continue;
    }
    const source = path.join(backup.path, "files", safeBackupName(rel));
    const target = path.join(ctx.agentDir, rel);
    if (item.exists === false) {
      if (!dryRun && fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
      removed.push({ path: rel, target, reason: "missing-at-backup-time" });
      continue;
    }
    if (!fs.existsSync(source)) {
      missing.push({ path: rel, source });
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      chmodPrivate(target);
    }
    restored.push({ path: rel, source, target });
  }

  return {
    schema: "pi67.backup-restore.v1",
    createdAt: new Date().toISOString(),
    dryRun,
    backup,
    preRestoreBackupDir: dryRun ? "" : preRestoreBackupDir,
    preRestoreBackedUp,
    restored,
    removed,
    missing,
    skipped,
  };
}

function acquireLock(lockPath, data) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const payload = {
    schema: "pi67.update-lock.v1",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...data,
  };
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (isStaleLock(lockPath)) {
      fs.unlinkSync(lockPath);
      return acquireLock(lockPath, data);
    }
    throw new CliError(`another pi-67 update appears to be running; lock exists: ${lockPath}`);
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function isStaleLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS) return true;
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (Number.isInteger(data.pid) && data.pid > 0) {
      try {
        process.kill(data.pid, 0);
        return false;
      } catch {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function backupSummary(backupDir) {
  const manifestPath = ["backup-manifest.json", "manifest.json"]
    .map((name) => path.join(backupDir, name))
    .find((file) => fs.existsSync(file));
  if (!manifestPath) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const files = Array.isArray(manifest.files)
      ? manifest.files.map((item) => ({
        path: item.path,
        exists: item.exists !== false,
        bytes: item.bytes,
        sha256: item.sha256,
      }))
      : (Array.isArray(manifest.paths) ? manifest.paths.map((item) => ({ path: item })) : []);
    const existingFileCount = files.filter((item) => item.exists !== false).length;
    return {
      id: path.basename(backupDir),
      path: backupDir,
      manifestPath,
      schema: manifest.schema || "",
      createdAt: manifest.createdAt || "",
      operation: manifest.operation || inferBackupOperation(path.basename(backupDir)),
      agentDir: manifest.agentDir || "",
      repoRoot: manifest.repoRoot || "",
      fileCount: existingFileCount,
      preservedCount: files.length,
      files,
    };
  } catch {
    return null;
  }
}

function resolveBackupDir(ctx, input) {
  if (!input) throw new CliError("backup id/path is required", 2);
  const expanded = expandHome(String(input));
  if (path.isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) {
    return path.resolve(expanded);
  }
  return path.join(ctx.stateDir, "backups", expanded);
}

function inferBackupOperation(id) {
  if (id.endsWith("-update")) return "update";
  if (id.endsWith("-repair")) return "repair";
  if (id.endsWith("-themes-set")) return "themes-set";
  if (id.endsWith("-pre-restore")) return "pre-restore";
  if (id.startsWith("pre-update-runtime-")) return "pre-update-runtime";
  return "unknown";
}

function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function safeBackupName(rel) {
  return rel.replace(/[\\/]/g, "__");
}

function chmodPrivate(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX mode bits.
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
