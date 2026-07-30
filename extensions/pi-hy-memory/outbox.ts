import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOutboxDirectories, resolveHyMemoryPaths } from "./config.ts";
import { HY_MEMORY_OUTBOX_SCHEMA, type CaptureMessage, type HyMemoryPaths, type OutboxJob } from "./types.ts";

export type OutboxPolicy = {
  maxActiveJobs: number;
  maxActiveBytes: number;
  maxDeadLetterJobs: number;
  maxDeadLetterBytes: number;
  deadLetterRetentionMs: number;
};

export const DEFAULT_OUTBOX_POLICY: Readonly<OutboxPolicy> = Object.freeze({
  maxActiveJobs: 1_000,
  maxActiveBytes: 64 * 1024 * 1024,
  maxDeadLetterJobs: 500,
  maxDeadLetterBytes: 32 * 1024 * 1024,
  deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1_000,
});

const MAX_OUTBOX_JOB_BYTES = 256 * 1024;
const ADMISSION_LOCK_STALE_MS = 30_000;

export type QueueCaptureInput = {
  userId: string;
  agentId: string;
  sessionId: string;
  leafId: string;
  messages: CaptureMessage[];
};

export function stableCaptureRequestId(input: QueueCaptureInput): string {
  const hash = crypto.createHash("sha256");
  hash.update(input.userId);
  hash.update("\0");
  hash.update(input.agentId);
  hash.update("\0");
  hash.update(input.sessionId);
  hash.update("\0");
  hash.update(input.leafId);
  hash.update("\0");
  hash.update(JSON.stringify(input.messages));
  return hash.digest("hex");
}

export function queueCapture(
  input: QueueCaptureInput,
  paths: HyMemoryPaths = resolveHyMemoryPaths(),
  policy: Readonly<OutboxPolicy> = DEFAULT_OUTBOX_POLICY,
): { requestId: string; queued: boolean; file: string } {
  ensureOutboxDirectories(paths);
  const requestId = stableCaptureRequestId(input);
  const filename = `${requestId}.json`;
  const candidates = [paths.pendingDir, paths.processingDir, paths.deadLetterDir].map((dir) => path.join(dir, filename));
  const file = candidates[0] as string;

  const now = new Date().toISOString();
  const job: OutboxJob = {
    schema: HY_MEMORY_OUTBOX_SCHEMA,
    requestId,
    userId: input.userId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    leafId: input.leafId,
    messages: input.messages,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const serialized = `${JSON.stringify(job)}\n`;
  const jobBytes = Buffer.byteLength(serialized);
  if (jobBytes > MAX_OUTBOX_JOB_BYTES) {
    throw new Error(`Hy-Memory outbox job exceeds ${MAX_OUTBOX_JOB_BYTES} bytes`);
  }

  return withAdmissionLock(paths, () => {
    pruneDeadLetters(paths, policy);
    if (candidates.some((candidate) => fs.existsSync(candidate))) return { requestId, queued: false, file };
    const status = inspectOutbox(paths, policy);
    if (status.pending + status.processing >= policy.maxActiveJobs || status.activeBytes + jobBytes > policy.maxActiveBytes) {
      throw new Error(
        `Hy-Memory outbox capacity exceeded (${status.pending + status.processing}/${policy.maxActiveJobs} jobs, ` +
        `${status.activeBytes}/${policy.maxActiveBytes} bytes)`,
      );
    }

    const tmp = path.join(paths.pendingDir, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The atomic rename normally removes the temporary path.
      }
    }
    return { requestId, queued: true, file };
  });
}

export function countOutbox(paths: HyMemoryPaths = resolveHyMemoryPaths()): {
  pending: number;
  processing: number;
  deadLetter: number;
} {
  return {
    pending: jsonFileCount(paths.pendingDir),
    processing: jsonFileCount(paths.processingDir),
    deadLetter: jsonFileCount(paths.deadLetterDir),
  };
}

export function inspectOutbox(
  paths: HyMemoryPaths = resolveHyMemoryPaths(),
  policy: Readonly<OutboxPolicy> = DEFAULT_OUTBOX_POLICY,
): {
  pending: number;
  processing: number;
  deadLetter: number;
  activeBytes: number;
  deadLetterBytes: number;
  saturated: boolean;
  limits: OutboxPolicy;
} {
  const pending = directoryUsage(paths.pendingDir);
  const processing = directoryUsage(paths.processingDir);
  const deadLetter = directoryUsage(paths.deadLetterDir);
  const activeBytes = pending.bytes + processing.bytes;
  return {
    pending: pending.jobs,
    processing: processing.jobs,
    deadLetter: deadLetter.jobs,
    activeBytes,
    deadLetterBytes: deadLetter.bytes,
    saturated: pending.jobs + processing.jobs >= policy.maxActiveJobs || activeBytes >= policy.maxActiveBytes,
    limits: { ...policy },
  };
}

export function pruneDeadLetters(
  paths: HyMemoryPaths = resolveHyMemoryPaths(),
  policy: Readonly<OutboxPolicy> = DEFAULT_OUTBOX_POLICY,
  nowMs = Date.now(),
): number {
  let entries: Array<{ file: string; updatedAt: number; bytes: number }> = [];
  try {
    entries = fs.readdirSync(paths.deadLetterDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = path.join(paths.deadLetterDir, entry.name);
        const stat = fs.statSync(file);
        return { file, updatedAt: outboxUpdatedAt(file, stat.mtimeMs), bytes: stat.size };
      });
  } catch {
    return 0;
  }

  const retained = entries
    .filter((entry) => nowMs - entry.updatedAt <= policy.deadLetterRetentionMs)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.file.localeCompare(right.file));
  const keep = new Set<string>();
  let keptBytes = 0;
  for (const entry of retained) {
    if (keep.size >= policy.maxDeadLetterJobs || keptBytes + entry.bytes > policy.maxDeadLetterBytes) continue;
    keep.add(entry.file);
    keptBytes += entry.bytes;
  }

  let removed = 0;
  for (const entry of entries) {
    if (keep.has(entry.file)) continue;
    try {
      fs.unlinkSync(entry.file);
      removed += 1;
    } catch {
      // Retention is best effort; status still exposes any files that remain.
    }
  }
  return removed;
}

function jsonFileCount(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function directoryUsage(dir: string): { jobs: number; bytes: number } {
  try {
    let jobs = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      jobs += 1;
      bytes += fs.statSync(path.join(dir, entry.name)).size;
    }
    return { jobs, bytes };
  } catch {
    return { jobs: 0, bytes: 0 };
  }
}

function outboxUpdatedAt(file: string, fallback: number): number {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const parsed = Date.parse(String(value.updatedAt || value.createdAt || ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function withAdmissionLock<T>(paths: HyMemoryPaths, action: () => T): T {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.mkdirSync(paths.outboxAdmissionLockDir, { mode: 0o700 });
      try {
        return action();
      } finally {
        try {
          fs.rmdirSync(paths.outboxAdmissionLockDir);
        } catch {
          // A crashed process leaves only an empty lock directory for stale recovery.
        }
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      recoverStaleAdmissionLock(paths.outboxAdmissionLockDir);
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
  throw new Error("Hy-Memory outbox admission is busy; retry after the current capture is queued");
}

function recoverStaleAdmissionLock(lockDir: string): void {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs <= ADMISSION_LOCK_STALE_MS) return;
    fs.rmdirSync(lockDir);
  } catch {
    // The owner may have released the lock between stat and removal.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}
