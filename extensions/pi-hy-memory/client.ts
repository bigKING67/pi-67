import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readConfig,
  readPiAuthKey,
  readRuntime,
  readSecrets,
  readServiceRecord,
  resolveHyMemoryPaths,
} from "./config.ts";
import type {
  CaptureMessage,
  HyMemoryConfig,
  HyMemoryPaths,
  HyMemoryOperationReceipt,
  HyMemoryServiceRecord,
  ServiceInfo,
} from "./types.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const POTENTIALLY_RETAINED_MEMORY_COPIES = [
  "history",
  "pipeline-trace",
  "pipeline-log",
  "reset-backups",
] as const;

export class HyMemoryOperationPendingError extends Error {
  readonly receipt: HyMemoryOperationReceipt;

  constructor(receipt: HyMemoryOperationReceipt) {
    super(`Hy-Memory ${receipt.kind} operation is ${receipt.state}: ${receipt.statusPath}`);
    this.name = "HyMemoryOperationPendingError";
    this.receipt = receipt;
  }
}

export class HyMemoryServiceClient {
  readonly config: HyMemoryConfig;
  readonly paths: HyMemoryPaths;

  constructor(config: HyMemoryConfig, paths: HyMemoryPaths = resolveHyMemoryPaths()) {
    this.config = config;
    this.paths = paths;
  }

  async info(timeoutMs = 1500): Promise<ServiceInfo> {
    return await this.request<ServiceInfo>("GET", "/v1/info", undefined, timeoutMs);
  }

  async search(query: string, timeoutMs = this.config.recall.timeoutMs): Promise<unknown> {
    return await this.request("POST", "/v1/search", {
      query,
      limit: this.config.recall.topK,
      minScore: this.config.recall.minScore,
      profileLimit: this.config.recall.profileLimit,
      profileMinScore: this.config.recall.profileMinScore,
      intentionLimit: this.config.recall.intentionLimit,
    }, timeoutMs);
  }

  async capture(messages: CaptureMessage[], sessionId: string, requestId?: string): Promise<unknown> {
    return await this.request("POST", "/v1/capture", { messages, sessionId, requestId }, 180000);
  }

  async list(limit = 20, offset = 0): Promise<unknown> {
    return await this.request("GET", `/v1/memories?limit=${limit}&offset=${offset}`, undefined, 10000);
  }

  async get(memoryId: string): Promise<unknown> {
    return await this.request("GET", `/v1/memories/${encodeURIComponent(memoryId)}`, undefined, 10000);
  }

  async forget(memoryId: string): Promise<unknown> {
    const result = await this.request("DELETE", `/v1/memories/${encodeURIComponent(memoryId)}`, undefined, 30000);
    if (isOperationReceipt(result)) return result;
    return activeDeleteResult(result);
  }

  async flush(): Promise<unknown> {
    return await this.request("POST", "/v1/flush", {}, 180000);
  }

  async probe(): Promise<unknown> {
    return await this.request("POST", "/v1/probe", {}, 30000);
  }

  async digest(operationId = crypto.randomBytes(32).toString("hex")): Promise<unknown> {
    return await this.request("POST", "/v1/digest", { operationId }, 900000);
  }

  async operation(operationId: string): Promise<HyMemoryOperationReceipt> {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new Error("Hy-Memory operation ID is invalid");
    return await this.request("GET", `/v1/operations/${operationId}`, undefined, 10000);
  }

  async shutdown(): Promise<unknown> {
    return await this.request("POST", "/v1/shutdown", {}, 10000);
  }

  private async request<T = unknown>(method: string, pathname: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const service = readServiceRecord(this.paths);
    if (!service) throw new Error("Hy-Memory service is not running");
    const secrets = readSecrets(this.paths);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${secrets.serviceBearerToken}`,
          "x-pi67-timeout-ms": String(timeoutMs),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Hy-Memory response exceeded the size limit");
      const text = await readResponseTextBounded(response, MAX_RESPONSE_BYTES);
      let value: unknown = {};
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Hy-Memory service returned invalid JSON (HTTP ${response.status})`);
      }
      if (isOperationReceipt(value)) {
        const readOnly = method === "GET" || pathname === "/v1/search" || pathname === "/v1/probe";
        if (readOnly && value.state !== "SUCCEEDED") throw new HyMemoryOperationPendingError(value);
        return value as T;
      }
      if (!response.ok) {
        const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
        throw new Error(`Hy-Memory service HTTP ${response.status}: ${String(record.error || "request failed")}`);
      }
      if (pathname === "/v1/info") validateServiceIdentity(value, service, this.paths);
      return value as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Hy-Memory request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function activeDeleteResult(value: unknown): Record<string, unknown> {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  const deletedCount = result.deleted_count;
  return {
    ...result,
    activeDeleted: Number.isInteger(deletedCount) && Number(deletedCount) > 0,
    purgeComplete: false,
    retainedCopies: [...POTENTIALLY_RETAINED_MEMORY_COPIES],
  };
}

export function isOperationReceipt(value: unknown): value is HyMemoryOperationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === "pi67-hy-memory-operation/v1"
    && typeof record.operationId === "string"
    && typeof record.state === "string"
    && typeof record.statusPath === "string";
}

export async function ensureHyMemoryService(
  config = readConfig(),
  paths = resolveHyMemoryPaths(),
  timeoutMs = 20000,
): Promise<HyMemoryServiceClient> {
  if (!config) throw new Error("Hy-Memory is not initialized; run `pi-67 memory init`");
  const runtime = readRuntime(paths);
  const client = new HyMemoryServiceClient(config, paths);
  if (await serviceReady(client)) return client;

  const owner = readLifetimeOwner(paths);
  if (owner && processExists(owner.pid)) {
    const ready = await waitForService(client, timeoutMs);
    if (ready) return client;
    throw new Error(`Hy-Memory lifetime owner PID ${owner.pid} is alive but no matching service became ready`);
  }
  const unownedService = readServiceRecordIfPresent(paths);
  if (unownedService && processExists(unownedService.pid)) {
    throw new Error(`Hy-Memory service PID ${unownedService.pid} is alive without matching lifetime ownership`);
  }

  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const lock = tryAcquireStartLock(paths);
  if (!lock.acquired) {
    const ready = await waitForService(client, timeoutMs);
    if (ready) return client;
    throw new Error("Hy-Memory service start is already in progress but did not become ready");
  }

  try {
    const secrets = readSecrets(paths);
    const llmApiKey = secrets.llmApiKey || readPiAuthKey(config.llm.keySource.provider);
    const child = spawn(runtime.python, [runtime.serviceScript, "--root", paths.root, "--port", "0"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: buildMemoryServiceEnvironment({
        llmApiKey,
        embeddingApiKey: secrets.embeddingApiKey,
        bearerToken: secrets.serviceBearerToken,
        dataDir: paths.dataDir,
      }),
    });
    child.unref();
    const ready = await waitForService(client, timeoutMs);
    if (!ready) throw new Error(`Hy-Memory service did not become ready within ${timeoutMs}ms`);
    return client;
  } finally {
    releaseStartLock(paths, lock.token);
  }
}

export async function stopHyMemoryService(paths = resolveHyMemoryPaths()): Promise<boolean> {
  const config = readConfig(paths);
  if (!config) return false;
  const client = new HyMemoryServiceClient(config, paths);
  if (!await serviceReady(client)) {
    const owner = readLifetimeOwner(paths);
    const service = readServiceRecordIfPresent(paths);
    if ((owner && processExists(owner.pid)) || (service && processExists(service.pid))) {
      throw new Error("Hy-Memory service ownership is inconsistent; run `pi-67 memory doctor`");
    }
    return false;
  }
  await client.shutdown();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!fs.existsSync(paths.serviceFile)) return true;
    await sleep(100);
  }
  return !fs.existsSync(paths.serviceFile);
}

async function serviceReady(client: HyMemoryServiceClient): Promise<boolean> {
  try {
    await client.info();
    return true;
  } catch {
    return false;
  }
}

async function waitForService(client: HyMemoryServiceClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serviceReady(client)) return true;
    await sleep(200);
  }
  return false;
}

function validateServiceIdentity(value: unknown, service: HyMemoryServiceRecord, paths: HyMemoryPaths): void {
  if (!value || typeof value !== "object") throw new Error("Hy-Memory service identity is invalid");
  const info = value as Record<string, unknown>;
  if (
    info.instanceId !== service.instanceId ||
    info.pid !== service.pid ||
    canonicalFilesystemPath(String(info.root || "")) !== canonicalFilesystemPath(paths.root) ||
    canonicalFilesystemPath(String(info.dataDir || "")) !== canonicalFilesystemPath(paths.dataDir)
  ) {
    throw new Error("Hy-Memory service identity does not match this installation");
  }
  const owner = readLifetimeOwner(paths);
  if (
    !owner || !processExists(owner.pid) || owner.pid !== service.pid || owner.instanceId !== service.instanceId ||
    canonicalFilesystemPath(owner.root) !== canonicalFilesystemPath(paths.root)
  ) {
    throw new Error("Hy-Memory service has no matching live lifetime owner");
  }
}

function readLifetimeOwner(paths: HyMemoryPaths): { pid: number; instanceId: string; root: string } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(paths.lifetimeOwnerFile, "utf8")) as Record<string, unknown>;
    if (!Number.isInteger(value.pid) || typeof value.instanceId !== "string" || typeof value.root !== "string") return undefined;
    return { pid: Number(value.pid), instanceId: value.instanceId, root: value.root };
  } catch {
    return undefined;
  }
}

function readServiceRecordIfPresent(paths: HyMemoryPaths): HyMemoryServiceRecord | undefined {
  try {
    return readServiceRecord(paths);
  } catch {
    return undefined;
  }
}

function canonicalFilesystemPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function tryAcquireStartLock(paths: HyMemoryPaths): { acquired: boolean; token: string } {
  const token = `${process.pid}:${Date.now()}`;
  try {
    fs.writeFileSync(paths.startLockFile, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { acquired: true, token };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const existing = readLock(paths.startLockFile);
  if (existing && processExists(existing.pid)) {
    return { acquired: false, token: "" };
  }
  try {
    fs.unlinkSync(paths.startLockFile);
  } catch {
    return { acquired: false, token: "" };
  }
  return tryAcquireStartLock(paths);
}

function releaseStartLock(paths: HyMemoryPaths, token: string): void {
  const existing = readLock(paths.startLockFile);
  if (!existing || existing.token !== token) return;
  try {
    fs.unlinkSync(paths.startLockFile);
  } catch {
    // Another process may already have recovered a stale lock.
  }
}

function readLock(file: string): { token: string; pid: number; createdAt: number } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof value.token !== "string" || !Number.isInteger(value.pid) || typeof value.createdAt !== "number") return undefined;
    return { token: value.token, pid: Number(value.pid), createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

export function buildMemoryServiceEnvironment(input: {
  llmApiKey: string;
  embeddingApiKey: string;
  bearerToken: string;
  dataDir: string;
}): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    PYTHONUNBUFFERED: "1",
    TOKENIZERS_PARALLELISM: "false",
    MEMORY_DATA_DIR: input.dataDir,
    MEMORY_LOG_LEVEL: "WARNING",
    MEMORY_CODING_ENABLED: "false",
    MEMORY_HISTORY_ENABLE: "false",
    MEMORY_MEMORY_OPERATIONS_ENABLED: "false",
    MEMORY_PIPELINE_TRACE_ENABLED: "false",
    MEMORY_TRACE_ENABLED: "false",
    PI67_HY_MEMORY_LLM_API_KEY: input.llmApiKey,
    PI67_HY_MEMORY_EMBEDDING_API_KEY: input.embeddingApiKey,
    PI67_HY_MEMORY_SERVICE_TOKEN: input.bearerToken,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new Error("Hy-Memory response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}
