import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOutboxDirectories, resolveHyMemoryPaths } from "./config.ts";
import { HY_MEMORY_OUTBOX_SCHEMA, type CaptureMessage, type HyMemoryPaths, type OutboxJob } from "./types.ts";

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
): { requestId: string; queued: boolean; file: string } {
  ensureOutboxDirectories(paths);
  const requestId = stableCaptureRequestId(input);
  const filename = `${requestId}.json`;
  const candidates = [paths.pendingDir, paths.processingDir, paths.deadLetterDir].map((dir) => path.join(dir, filename));
  const file = candidates[0] as string;
  if (candidates.some((candidate) => fs.existsSync(candidate))) return { requestId, queued: false, file };

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
  const tmp = path.join(paths.pendingDir, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The atomic rename normally removes the temporary path.
    }
  }
  return { requestId, queued: true, file };
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

function jsonFileCount(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
