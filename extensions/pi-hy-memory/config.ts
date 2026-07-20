import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HY_MEMORY_CONFIG_SCHEMA,
  HY_MEMORY_RUNTIME_SCHEMA,
  HY_MEMORY_SECRETS_SCHEMA,
  HY_MEMORY_SERVICE_SCHEMA,
  type HyMemoryConfig,
  type HyMemoryPaths,
  type HyMemoryRuntime,
  type HyMemorySecrets,
  type HyMemoryServiceRecord,
} from "./types.ts";

const EXPECTED_LLM_BASE_URL = "https://api.deepseek.com";
const EXPECTED_LLM_MODEL = "deepseek-v4-flash";
const EXPECTED_EMBED_BASE_URL = "https://api.siliconflow.cn/v1";
const EXPECTED_EMBED_MODEL = "BAAI/bge-m3";
const EXPECTED_VECTOR_DIMENSIONS = 1024;

export function resolveHyMemoryPaths(homeOverride?: string): HyMemoryPaths {
  const root = path.resolve(
    homeOverride || process.env.PI67_HY_MEMORY_HOME || path.join(os.homedir(), ".hy-memory", "pi67"),
  );
  const outboxDir = path.join(root, "outbox");
  const runtimeDir = path.join(root, "runtime");
  return {
    root,
    configFile: path.join(root, "config.json"),
    secretsFile: path.join(root, "secrets.json"),
    dataDir: path.join(root, "data"),
    outboxDir,
    pendingDir: path.join(outboxDir, "pending"),
    processingDir: path.join(outboxDir, "processing"),
    deadLetterDir: path.join(outboxDir, "dead-letter"),
    runtimeDir,
    runtimeFile: path.join(runtimeDir, "current.json"),
    serviceFile: path.join(runtimeDir, "service.json"),
    startLockFile: path.join(runtimeDir, "start.lock"),
    logsDir: path.join(root, "logs"),
  };
}

export function readConfig(paths = resolveHyMemoryPaths()): HyMemoryConfig | undefined {
  if (!fs.existsSync(paths.configFile)) return undefined;
  const value = readJsonObject(paths.configFile);
  validateConfig(value, paths.configFile);
  return value as HyMemoryConfig;
}

export function readSecrets(paths = resolveHyMemoryPaths()): HyMemorySecrets {
  const value = readJsonObject(paths.secretsFile);
  if (value.schema !== HY_MEMORY_SECRETS_SCHEMA) {
    throw new Error(`unsupported Hy-Memory secrets schema in ${paths.secretsFile}`);
  }
  if (!nonEmptyString(value.embeddingApiKey) || !nonEmptyString(value.serviceBearerToken)) {
    throw new Error(`Hy-Memory secrets are incomplete in ${paths.secretsFile}`);
  }
  return value as HyMemorySecrets;
}

export function readRuntime(paths = resolveHyMemoryPaths()): HyMemoryRuntime {
  const value = readJsonObject(paths.runtimeFile);
  if (value.schema !== HY_MEMORY_RUNTIME_SCHEMA) {
    throw new Error(`unsupported Hy-Memory runtime schema in ${paths.runtimeFile}`);
  }
  for (const key of ["sdkVersion", "python", "serviceScript", "wheelSha256", "installedAt"] as const) {
    if (!nonEmptyString(value[key])) throw new Error(`Hy-Memory runtime is missing ${key}`);
  }
  return value as HyMemoryRuntime;
}

export function readServiceRecord(paths = resolveHyMemoryPaths()): HyMemoryServiceRecord | undefined {
  if (!fs.existsSync(paths.serviceFile)) return undefined;
  const value = readJsonObject(paths.serviceFile);
  if (
    value.schema !== HY_MEMORY_SERVICE_SCHEMA ||
    !Number.isInteger(value.pid) ||
    !Number.isInteger(value.port) ||
    !nonEmptyString(value.instanceId) ||
    !nonEmptyString(value.root) ||
    !nonEmptyString(value.dataDir)
  ) {
    throw new Error(`invalid Hy-Memory service metadata in ${paths.serviceFile}`);
  }
  return value as HyMemoryServiceRecord;
}

export function readPiAuthKey(provider: string, agentDir?: string): string {
  const root = agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const file = path.join(root, "auth.json");
  const auth = readJsonObject(file);
  const entry = auth[provider];
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    for (const key of ["key", "apiKey", "token"]) {
      if (nonEmptyString(record[key])) return String(record[key]).trim();
    }
  }
  throw new Error(`Pi auth provider '${provider}' has no usable credential in ${file}`);
}

export function ensureOutboxDirectories(paths = resolveHyMemoryPaths()): void {
  for (const dir of [
    paths.root,
    paths.dataDir,
    paths.pendingDir,
    paths.processingDir,
    paths.deadLetterDir,
    paths.runtimeDir,
    paths.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function validateConfig(value: Record<string, unknown>, source = "config"): asserts value is HyMemoryConfig {
  if (value.schema !== HY_MEMORY_CONFIG_SCHEMA) throw new Error(`unsupported Hy-Memory config schema in ${source}`);
  if (typeof value.enabled !== "boolean") throw new Error(`Hy-Memory enabled must be boolean in ${source}`);
  if (value.mode !== "pro") throw new Error(`Hy-Memory mode must be pro in ${source}`);
  if (!nonEmptyString(value.userId) || !nonEmptyString(value.agentId)) {
    throw new Error(`Hy-Memory userId/agentId are required in ${source}`);
  }

  const llm = objectValue(value.llm, "llm", source);
  const keySource = objectValue(llm.keySource, "llm.keySource", source);
  if (
    llm.provider !== "openai" ||
    llm.baseUrl !== EXPECTED_LLM_BASE_URL ||
    llm.model !== EXPECTED_LLM_MODEL ||
    keySource.type !== "pi-auth" ||
    !nonEmptyString(keySource.provider)
  ) {
    throw new Error(`Hy-Memory LLM contract is not canonical in ${source}`);
  }

  const embedder = objectValue(value.embedder, "embedder", source);
  if (
    embedder.provider !== "openai" ||
    embedder.baseUrl !== EXPECTED_EMBED_BASE_URL ||
    embedder.model !== EXPECTED_EMBED_MODEL ||
    embedder.requestDimensions !== null ||
    embedder.vectorDimensions !== EXPECTED_VECTOR_DIMENSIONS
  ) {
    throw new Error(`Hy-Memory BGE-M3 embedding contract is not canonical in ${source}`);
  }

  validateNumberOptions(objectValue(value.recall, "recall", source), [
    "topK", "minScore", "profileLimit", "profileMinScore", "intentionLimit", "timeoutMs", "maxChars",
  ], source);
  validateNumberOptions(objectValue(value.capture, "capture", source), [
    "maxMessageChars", "batchTurns", "maxDelayMs", "maxAttempts",
  ], source);
}

function validateNumberOptions(record: Record<string, unknown>, keys: string[], source: string): void {
  for (const key of keys) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || Number(record[key]) < 0) {
      throw new Error(`Hy-Memory ${key} must be a non-negative number in ${source}`);
    }
  }
}

function objectValue(value: unknown, label: string, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hy-Memory ${label} must be an object in ${source}`);
  }
  return value as Record<string, unknown>;
}

function readJsonObject(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
