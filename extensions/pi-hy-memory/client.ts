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
  HyMemoryServiceRecord,
  ServiceInfo,
} from "./types.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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
    return await this.request("DELETE", `/v1/memories/${encodeURIComponent(memoryId)}`, undefined, 30000);
  }

  async flush(): Promise<unknown> {
    return await this.request("POST", "/v1/flush", {}, 180000);
  }

  async probe(): Promise<unknown> {
    return await this.request("POST", "/v1/probe", {}, 30000);
  }

  async digest(): Promise<unknown> {
    return await this.request("POST", "/v1/digest", {}, 900000);
  }

  async shutdown(): Promise<unknown> {
    return await this.request("POST", "/v1/shutdown", {}, 10000);
  }

  private async request<T = unknown>(method: string, pathname: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const service = readServiceRecord(this.paths);
    if (!service) throw new Error("Hy-Memory service is not running");
    const secrets = readSecrets(this.paths);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${secrets.serviceBearerToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Hy-Memory response exceeded the size limit");
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Hy-Memory response exceeded the size limit");
      let value: unknown = {};
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Hy-Memory service returned invalid JSON (HTTP ${response.status})`);
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

export async function ensureHyMemoryService(
  config = readConfig(),
  paths = resolveHyMemoryPaths(),
  timeoutMs = 20000,
): Promise<HyMemoryServiceClient> {
  if (!config) throw new Error("Hy-Memory is not initialized; run `pi-67 memory init`");
  const client = new HyMemoryServiceClient(config, paths);
  if (await serviceReady(client)) return client;

  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const lock = tryAcquireStartLock(paths);
  if (!lock.acquired) {
    const ready = await waitForService(client, timeoutMs);
    if (ready) return client;
    throw new Error("Hy-Memory service start is already in progress but did not become ready");
  }

  try {
    const runtime = readRuntime(paths);
    const secrets = readSecrets(paths);
    const llmApiKey = secrets.llmApiKey || readPiAuthKey(config.llm.keySource.provider);
    const child = spawn(runtime.python, [runtime.serviceScript, "--root", paths.root, "--port", "0"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: serviceEnvironment({
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
  if (!await serviceReady(client)) return false;
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
  if (existing && processExists(existing.pid) && Date.now() - existing.createdAt < 120000) {
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

function serviceEnvironment(input: {
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
    PI67_HY_MEMORY_LLM_API_KEY: input.llmApiKey,
    PI67_HY_MEMORY_EMBEDDING_API_KEY: input.embeddingApiKey,
    PI67_HY_MEMORY_SERVICE_TOKEN: input.bearerToken,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
