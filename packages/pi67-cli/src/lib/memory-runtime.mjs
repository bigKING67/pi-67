import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CliError } from "./output.mjs";
import { replaceFileSafely } from "./xtalpi-config.mjs";

export const HY_MEMORY_SDK_VERSION = "1.2.20";
export const HY_MEMORY_WHEEL_SHA256 = "9055a2b793e553aead5558c821f1a69667aac20838929f314c95bfd6c3bf3cc2";
export const HY_MEMORY_WHEEL_URL = "https://files.pythonhosted.org/packages/f9/f4/08e98e6313f0592a7c6ca52c7e90b5e22fb025bcb138432545a11e5d3fa8/hy_memory-1.2.20-py3-none-any.whl";

const CONFIG_SCHEMA = "pi67-hy-memory-config/v1";
const SECRETS_SCHEMA = "pi67-hy-memory-secrets/v1";
const RUNTIME_SCHEMA = "pi67-hy-memory-runtime/v1";
const SERVICE_SCHEMA = "pi67-hy-memory-service/v1";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;

export function memoryPaths(homeOverride = process.env.PI67_HY_MEMORY_HOME) {
  const root = path.resolve(homeOverride || path.join(os.homedir(), ".hy-memory", "pi67"));
  return {
    root,
    configFile: path.join(root, "config.json"),
    secretsFile: path.join(root, "secrets.json"),
    dataDir: path.join(root, "data"),
    outboxDir: path.join(root, "outbox"),
    pendingDir: path.join(root, "outbox", "pending"),
    processingDir: path.join(root, "outbox", "processing"),
    deadLetterDir: path.join(root, "outbox", "dead-letter"),
    runtimeDir: path.join(root, "runtime"),
    runtimeFile: path.join(root, "runtime", "current.json"),
    serviceFile: path.join(root, "runtime", "service.json"),
    startLockFile: path.join(root, "runtime", "start.lock"),
    logsDir: path.join(root, "logs"),
  };
}

export function defaultMemoryConfig(userId = crypto.randomUUID()) {
  return {
    schema: CONFIG_SCHEMA,
    enabled: true,
    mode: "pro",
    userId,
    agentId: "pi-67",
    llm: {
      provider: "openai",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      keySource: { type: "pi-auth", provider: "deepseek" },
    },
    embedder: {
      provider: "openai",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3",
      requestDimensions: null,
      vectorDimensions: 1024,
    },
    recall: {
      topK: 5,
      minScore: 0.3,
      profileLimit: 5,
      profileMinScore: 0.4,
      intentionLimit: 0,
      timeoutMs: 5000,
      maxChars: 4000,
    },
    capture: {
      maxMessageChars: 12000,
      batchTurns: 5,
      maxDelayMs: 60000,
      maxAttempts: 5,
    },
  };
}

export async function initializeMemory(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  if (fs.existsSync(paths.configFile)) {
    throw new CliError("Hy-Memory is already initialized; use `pi-67 memory upgrade` or `pi-67 memory doctor`");
  }
  const embeddingApiKey = String(options.embeddingApiKey || "").trim();
  const deepseek = inspectPiAuth(ctx.agentDir, "deepseek");
  if (!deepseek.present) {
    throw new CliError(`DeepSeek auth is missing in ${deepseek.file}; configure provider 'deepseek' in upstream Pi first`);
  }
  if (!embeddingApiKey && !options.dryRun) {
    throw new CliError("SiliconFlow embedding API key is required through hidden input or PI67_HY_MEMORY_EMBEDDING_API_KEY");
  }

  const config = defaultMemoryConfig();
  const plan = {
    schema: "pi67.memory-init-plan/v1",
    root: paths.root,
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python: "3.11",
    llm: { provider: "deepseek", model: config.llm.model, credentialSource: "Pi auth.json" },
    embedder: { provider: "siliconflow", model: config.embedder.model, vectorDimensions: 1024 },
    dataPolicy: "local-per-system-user-cross-project",
  };
  if (options.dryRun) return { ...plan, dryRun: true, initialized: false };

  ensureStateDirectories(paths);
  const runtime = await installMemoryRuntime(ctx, { paths, force: false });
  const secrets = {
    schema: SECRETS_SCHEMA,
    embeddingApiKey,
    serviceBearerToken: crypto.randomBytes(32).toString("base64url"),
  };
  writeJsonSecure(paths.configFile, config);
  writeJsonSecure(paths.secretsFile, secrets);
  const service = await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  return {
    schema: "pi67.memory-init/v1",
    initialized: true,
    root: paths.root,
    config: publicConfig(config),
    runtime: publicRuntime(runtime),
    service,
  };
}

export async function installMemoryRuntime(ctx, options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  const source = path.join(ctx.repoRoot, "extensions", "pi-hy-memory", "service.py");
  if (!fs.existsSync(source)) throw new CliError(`Hy-Memory service source is missing: ${source}`);
  ensureStateDirectories(paths);

  const serviceHash = sha256File(source);
  const installRoot = path.join(paths.runtimeDir, `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${serviceHash.slice(0, 12)}`);
  const serviceScript = path.join(installRoot, "service.py");
  const python = venvPython(path.join(installRoot, "venv"));
  const runtime = {
    schema: RUNTIME_SCHEMA,
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python,
    serviceScript,
    wheelSha256: HY_MEMORY_WHEEL_SHA256,
    installedAt: new Date().toISOString(),
  };

  if (!options.force && fs.existsSync(python) && fs.existsSync(serviceScript)) {
    verifyPythonRuntime(python);
    writeJsonSecure(paths.runtimeFile, runtime);
    return runtime;
  }

  const createdNow = !fs.existsSync(installRoot);
  try {
    fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
    const wheelDir = path.join(paths.runtimeDir, "downloads");
    fs.mkdirSync(wheelDir, { recursive: true, mode: 0o700 });
    const wheelFile = path.join(wheelDir, "hy_memory-1.2.20-py3-none-any.whl");
    await downloadVerifiedWheel(wheelFile);

    const uv = commandAvailable("uv", ["--version"]);
    if (uv) {
      runChecked("uv", ["venv", "--python", "3.11", path.join(installRoot, "venv")], { timeoutMs: 10 * 60_000 });
      runChecked("uv", ["pip", "install", "--python", python, wheelFile], { timeoutMs: 30 * 60_000 });
    } else {
      const creator = python311Creator();
      if (!creator) {
        throw new CliError("Python 3.11 is required. Install uv or Python 3.11, then rerun `pi-67 memory init`");
      }
      runChecked(creator.command, [...creator.prefix, "-m", "venv", path.join(installRoot, "venv")], {
        timeoutMs: 10 * 60_000,
      });
      runChecked(python, ["-m", "pip", "install", wheelFile], { timeoutMs: 30 * 60_000 });
    }

    fs.copyFileSync(source, serviceScript);
    try {
      fs.chmodSync(serviceScript, 0o700);
    } catch {
      // Windows executable ACLs follow the user profile.
    }
    verifyPythonRuntime(python);
    writeJsonSecure(paths.runtimeFile, runtime);
    return runtime;
  } catch (error) {
    if (createdNow && path.resolve(installRoot).startsWith(`${path.resolve(paths.runtimeDir)}${path.sep}`)) {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function memoryStatus(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  const checks = [];
  let config;
  let runtime;
  let service;
  let secrets;

  try {
    config = readJsonObject(paths.configFile);
    validateMemoryConfig(config);
    checks.push(check("config", true, "config schema and provider contracts are canonical"));
  } catch (error) {
    checks.push(check("config", false, fs.existsSync(paths.configFile) ? safeMessage(error) : "not initialized"));
  }
  try {
    secrets = readSecrets(paths);
    const permissions = secureMode(paths.secretsFile);
    checks.push(check(
      "secrets",
      permissions.ok,
      permissions.ok ? "required secrets are present and private" : `secrets file mode ${permissions.mode} is too broad`,
      permissions,
    ));
  } catch (error) {
    checks.push(check("secrets", false, safeMessage(error)));
  }
  try {
    runtime = readRuntime(paths);
    if (!fs.existsSync(runtime.python)) throw new CliError(`Python runtime is missing: ${runtime.python}`);
    checks.push(check("runtime", true, `hy-memory ${runtime.sdkVersion} runtime metadata and files are present`));
  } catch (error) {
    checks.push(check("runtime", false, safeMessage(error)));
  }
  if (config && secrets) {
    try {
      service = await memoryServiceRequest(paths, "GET", "/v1/info", undefined, 1500);
      validateServiceIdentity(service, readServiceRecord(paths), paths);
      checks.push(check("service", true, `authenticated loopback service is running on PID ${service.pid}`));
    } catch (error) {
      checks.push(check("service", false, "authenticated loopback service is not running"));
    }
  } else {
    checks.push(check("service", false, "service cannot run before initialization"));
  }

  const outbox = outboxCounts(paths);
  const initialized = Boolean(config && runtime && secrets);
  return {
    schema: "pi67.memory-status/v1",
    initialized,
    enabled: Boolean(config?.enabled),
    ready: initialized && checks.filter((item) => item.id !== "service").every((item) => item.ok),
    running: Boolean(service),
    root: paths.root,
    config: config ? publicConfig(config) : null,
    runtime: runtime ? publicRuntime(runtime) : null,
    service: service || null,
    outbox,
    checks,
    nextSteps: memoryNextSteps({ initialized, config, runtime, secrets, service, outbox }),
  };
}

export async function doctorMemory(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  let status = await memoryStatus(ctx, { home: options.home });
  const checks = [...status.checks];
  let probe = null;
  if (status.runtime) {
    try {
      verifyPythonRuntime(status.runtime.python);
      checks.push(check("runtime-import", true, `Python 3.11 imports hy-memory ${HY_MEMORY_SDK_VERSION}`));
    } catch (error) {
      checks.push(check("runtime-import", false, safeMessage(error)));
    }
  }
  if (options.deep && status.initialized) {
    try {
      await startMemoryService(ctx, { paths, timeoutMs: options.timeoutMs || 45000 });
      probe = await memoryServiceRequest(paths, "POST", "/v1/probe", {}, options.timeoutMs || 30000);
      const correct = probe?.vectorDimensions === 1024 && probe?.finite === true;
      checks.push(check("embedding-probe", correct, correct
        ? "BAAI/bge-m3 returned a finite 1024-dimensional vector through Hy-Memory"
        : `embedding probe returned dimensions=${probe?.vectorDimensions ?? "unknown"}`));
    } catch (error) {
      checks.push(check("embedding-probe", false, safeMessage(error)));
    }
    status = await memoryStatus(ctx, { home: options.home });
  }
  const required = checks.filter((item) => options.deep || item.id !== "service");
  return {
    schema: "pi67.memory-doctor/v1",
    deep: Boolean(options.deep),
    ready: required.every((item) => item.ok),
    checks,
    probe,
    status,
  };
}

export async function startMemoryService(ctx, options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  const config = readConfig(paths);
  const existing = await tryServiceInfo(paths);
  if (existing) return { running: true, started: false, info: existing };

  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const lock = acquireStartLock(paths);
  if (!lock.acquired) {
    const info = await waitForService(paths, options.timeoutMs || 45000);
    if (info) return { running: true, started: false, info };
    throw new CliError("Hy-Memory service start is already in progress but did not become ready");
  }

  try {
    const runtime = readRuntime(paths);
    const secrets = readSecrets(paths);
    const llmKey = secrets.llmApiKey || readPiAuthCredential(ctx.agentDir, config.llm.keySource.provider);
    const child = spawn(runtime.python, [runtime.serviceScript, "--root", paths.root, "--port", "0"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: serviceEnvironment({
        llmKey,
        embeddingKey: secrets.embeddingApiKey,
        token: secrets.serviceBearerToken,
        dataDir: paths.dataDir,
      }),
    });
    child.unref();
    const info = await waitForService(paths, options.timeoutMs || 45000);
    if (!info) throw new CliError("Hy-Memory service did not become ready; inspect ~/.hy-memory/pi67/logs/service.log");
    return { running: true, started: true, info };
  } finally {
    releaseStartLock(paths, lock.token);
  }
}

export async function stopMemoryService(options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  const info = await tryServiceInfo(paths);
  if (!info) return { running: false, stopped: false };
  await memoryServiceRequest(paths, "POST", "/v1/shutdown", {}, 10000);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!await tryServiceInfo(paths)) return { running: false, stopped: true, previousPid: info.pid };
    await sleep(100);
  }
  throw new CliError("Hy-Memory service acknowledged shutdown but is still running");
}

export async function restartMemoryService(ctx, options = {}) {
  await stopMemoryService(options);
  return await startMemoryService(ctx, options);
}

export async function setMemoryEnabled(enabled, options = {}) {
  const paths = memoryPaths(options.home);
  const config = readConfig(paths);
  if (config.enabled === enabled) return { changed: false, enabled };
  writeJsonSecure(paths.configFile, { ...config, enabled });
  return { changed: true, enabled };
}

export async function upgradeMemory(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  readConfig(paths);
  readSecrets(paths);
  if (options.dryRun) {
    return {
      schema: "pi67.memory-upgrade/v1",
      dryRun: true,
      root: paths.root,
      sdkVersion: HY_MEMORY_SDK_VERSION,
      preserves: ["config.json", "secrets.json", "data/", "outbox/"],
    };
  }
  const wasRunning = Boolean(await tryServiceInfo(paths));
  if (wasRunning) await stopMemoryService({ paths });
  const runtime = await installMemoryRuntime(ctx, { paths, force: Boolean(options.force) });
  const service = wasRunning ? await startMemoryService(ctx, { paths, timeoutMs: 45000 }) : null;
  return {
    schema: "pi67.memory-upgrade/v1",
    upgraded: true,
    runtime: publicRuntime(runtime),
    restarted: Boolean(service),
  };
}

export async function forgetMemory(ctx, memoryId, options = {}) {
  if (!options.yes) throw new CliError("permanent deletion requires --yes", 2);
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(memoryId || "")) throw new CliError("memory ID is invalid", 2);
  const paths = memoryPaths(options.home);
  await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  return await memoryServiceRequest(paths, "DELETE", `/v1/memories/${encodeURIComponent(memoryId)}`, undefined, 30000);
}

export async function digestMemory(ctx, options = {}) {
  if (!options.yes) throw new CliError("System 2 digest is non-idempotent and requires --yes", 2);
  const paths = memoryPaths(options.home);
  await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  return await memoryServiceRequest(paths, "POST", "/v1/digest", {}, options.timeoutMs || 15 * 60_000);
}

export async function resetMemory(options = {}) {
  if (!options.yes) throw new CliError("reset requires --yes", 2);
  const paths = memoryPaths(options.home);
  if (!fs.existsSync(paths.root)) return { reset: false, reason: "not initialized" };
  await stopMemoryService({ paths });
  const backup = `${paths.root}.reset-backup-${timestampForPath()}`;
  fs.renameSync(paths.root, backup);
  return { reset: true, backup };
}

export async function flushMemory(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  return await memoryServiceRequest(paths, "POST", "/v1/flush", {}, options.timeoutMs || 180000);
}

export function embeddingKeyFromEnv() {
  const value = String(process.env.PI67_HY_MEMORY_EMBEDDING_API_KEY || "").trim();
  return { value, source: value ? "PI67_HY_MEMORY_EMBEDDING_API_KEY" : "" };
}

function validateMemoryConfig(config) {
  const expected = defaultMemoryConfig(config.userId);
  if (config.schema !== CONFIG_SCHEMA || config.mode !== "pro" || typeof config.enabled !== "boolean") {
    throw new CliError("Hy-Memory config schema/mode is invalid");
  }
  if (!config.userId || config.agentId !== "pi-67") throw new CliError("Hy-Memory userId/agentId is invalid");
  if (
    config.llm?.provider !== expected.llm.provider ||
    config.llm?.baseUrl !== expected.llm.baseUrl ||
    config.llm?.model !== expected.llm.model ||
    config.llm?.keySource?.type !== "pi-auth" ||
    !config.llm?.keySource?.provider
  ) throw new CliError("Hy-Memory LLM contract is not canonical");
  if (
    config.embedder?.provider !== expected.embedder.provider ||
    config.embedder?.baseUrl !== expected.embedder.baseUrl ||
    config.embedder?.model !== expected.embedder.model ||
    config.embedder?.requestDimensions !== null ||
    config.embedder?.vectorDimensions !== 1024
  ) throw new CliError("Hy-Memory BGE-M3 contract is not canonical");
  return true;
}

function readConfig(paths) {
  const config = readJsonObject(paths.configFile);
  validateMemoryConfig(config);
  return config;
}

function readSecrets(paths) {
  const secrets = readJsonObject(paths.secretsFile);
  if (
    secrets.schema !== SECRETS_SCHEMA ||
    typeof secrets.embeddingApiKey !== "string" || !secrets.embeddingApiKey.trim() ||
    typeof secrets.serviceBearerToken !== "string" || !secrets.serviceBearerToken.trim()
  ) throw new CliError(`Hy-Memory secrets are incomplete in ${paths.secretsFile}`);
  return secrets;
}

function readRuntime(paths) {
  const runtime = readJsonObject(paths.runtimeFile);
  if (
    runtime.schema !== RUNTIME_SCHEMA || runtime.sdkVersion !== HY_MEMORY_SDK_VERSION ||
    typeof runtime.python !== "string" || typeof runtime.serviceScript !== "string" ||
    runtime.wheelSha256 !== HY_MEMORY_WHEEL_SHA256
  ) throw new CliError(`Hy-Memory runtime metadata is invalid in ${paths.runtimeFile}`);
  if (!fs.existsSync(runtime.serviceScript)) throw new CliError(`Hy-Memory service script is missing: ${runtime.serviceScript}`);
  return runtime;
}

function readServiceRecord(paths) {
  const service = readJsonObject(paths.serviceFile);
  if (
    service.schema !== SERVICE_SCHEMA || !Number.isInteger(service.pid) || !Number.isInteger(service.port) ||
    typeof service.instanceId !== "string"
  ) throw new CliError("Hy-Memory service metadata is invalid");
  return service;
}

function readJsonObject(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`could not read ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError(`${file} must contain a JSON object`);
  return parsed;
}

function writeJsonSecure(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    replaceFileSafely(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACLs are inherited from the user's profile.
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Atomic rename removes the temporary path on success.
    }
  }
}

function ensureStateDirectories(paths) {
  for (const dir of [
    paths.root, paths.dataDir, paths.pendingDir, paths.processingDir, paths.deadLetterDir, paths.runtimeDir, paths.logsDir,
  ]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function downloadVerifiedWheel(destination) {
  if (fs.existsSync(destination) && sha256File(destination) === HY_MEMORY_WHEEL_SHA256) return;
  const response = await fetch(HY_MEMORY_WHEEL_URL, { redirect: "follow" });
  if (!response.ok) throw new CliError(`Hy-Memory wheel download failed with HTTP ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(raw).digest("hex");
  if (actual !== HY_MEMORY_WHEEL_SHA256) {
    throw new CliError(`Hy-Memory wheel checksum mismatch: expected ${HY_MEMORY_WHEEL_SHA256}, got ${actual}`);
  }
  const tmp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    replaceFileSafely(tmp, destination);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Atomic rename removes the temporary path on success.
    }
  }
}

function verifyPythonRuntime(python) {
  if (!fs.existsSync(python)) throw new CliError(`Python runtime is missing: ${python}`);
  const result = spawnSync(python, ["-c", "import hy_memory,sys; print(sys.version_info[:2], hy_memory.__version__)"], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout).includes(HY_MEMORY_SDK_VERSION) || !String(result.stdout).includes("(3, 11)")) {
    throw new CliError(`Hy-Memory Python 3.11 runtime verification failed: ${safeOutput(result.stderr || result.stdout)}`);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw new CliError(`failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`${command} exited with ${result.status}: ${safeOutput(result.stderr || result.stdout)}`);
  return result;
}

function python311Creator() {
  if (commandAvailable("python3.11", ["--version"])) return { command: "python3.11", prefix: [] };
  if (commandAvailable("py", ["-3.11", "--version"])) return { command: "py", prefix: ["-3.11"] };
  return null;
}

function commandAvailable(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
  return result.status === 0 && !result.error;
}

function venvPython(venv) {
  return process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

function inspectPiAuth(agentDir, provider) {
  const file = path.join(agentDir, "auth.json");
  try {
    const auth = readJsonObject(file);
    const entry = auth[provider];
    const present = Boolean(
      (typeof entry === "string" && entry.trim()) ||
      (entry && typeof entry === "object" && [entry.key, entry.apiKey, entry.token].some((value) => typeof value === "string" && value.trim())),
    );
    return { file, present };
  } catch {
    return { file, present: false };
  }
}

function readPiAuthCredential(agentDir, provider) {
  const file = path.join(agentDir, "auth.json");
  const auth = readJsonObject(file);
  const entry = auth[provider];
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    for (const key of ["key", "apiKey", "token"]) {
      if (typeof entry[key] === "string" && entry[key].trim()) return entry[key].trim();
    }
  }
  throw new CliError(`Pi auth provider '${provider}' has no usable credential in ${file}`);
}

async function memoryServiceRequest(paths, method, pathname, body, timeoutMs) {
  const service = readServiceRecord(paths);
  const secrets = readSecrets(paths);
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
    if (Number(response.headers.get("content-length") || 0) > MAX_HTTP_BYTES) throw new CliError("Hy-Memory response is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTTP_BYTES) throw new CliError("Hy-Memory response is too large");
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new CliError(`Hy-Memory service returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) throw new CliError(`Hy-Memory service HTTP ${response.status}: ${String(value.error || "request failed")}`);
    if (pathname === "/v1/info") validateServiceIdentity(value, service, paths);
    return value;
  } catch (error) {
    if (error?.name === "AbortError") throw new CliError(`Hy-Memory request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function tryServiceInfo(paths) {
  try {
    return await memoryServiceRequest(paths, "GET", "/v1/info", undefined, 1500);
  } catch {
    return null;
  }
}

function validateServiceIdentity(info, service, paths) {
  if (
    !info || info.schema !== SERVICE_SCHEMA || info.instanceId !== service.instanceId || info.pid !== service.pid ||
    canonicalFilesystemPath(String(info.root || "")) !== canonicalFilesystemPath(paths.root) ||
    canonicalFilesystemPath(String(info.dataDir || "")) !== canonicalFilesystemPath(paths.dataDir)
  ) throw new CliError("Hy-Memory service identity does not match this installation");
}

function canonicalFilesystemPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function waitForService(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await tryServiceInfo(paths);
    if (info) return info;
    await sleep(200);
  }
  return null;
}

function acquireStartLock(paths) {
  const token = `${process.pid}:${Date.now()}`;
  try {
    fs.writeFileSync(paths.startLockFile, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    return { acquired: true, token };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const existing = readStartLock(paths.startLockFile);
  if (existing && processExists(existing.pid) && Date.now() - existing.createdAt < 120000) {
    return { acquired: false, token: "" };
  }
  try {
    fs.unlinkSync(paths.startLockFile);
  } catch {
    return { acquired: false, token: "" };
  }
  return acquireStartLock(paths);
}

function releaseStartLock(paths, token) {
  const existing = readStartLock(paths.startLockFile);
  if (!existing || existing.token !== token) return;
  try {
    fs.unlinkSync(paths.startLockFile);
  } catch {
    // Another process may have recovered a stale lock.
  }
}

function readStartLock(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value.token !== "string" || !Number.isInteger(value.pid) || typeof value.createdAt !== "number") return null;
    return value;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serviceEnvironment(input) {
  const allowed = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA"];
  const env = {};
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  return {
    ...env,
    PYTHONUNBUFFERED: "1",
    TOKENIZERS_PARALLELISM: "false",
    MEMORY_DATA_DIR: input.dataDir,
    MEMORY_LOG_LEVEL: "WARNING",
    PI67_HY_MEMORY_LLM_API_KEY: input.llmKey,
    PI67_HY_MEMORY_EMBEDDING_API_KEY: input.embeddingKey,
    PI67_HY_MEMORY_SERVICE_TOKEN: input.token,
  };
}

function outboxCounts(paths) {
  return {
    pending: countJson(paths.pendingDir),
    processing: countJson(paths.processingDir),
    deadLetter: countJson(paths.deadLetterDir),
  };
}

function countJson(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function secureMode(file) {
  if (process.platform === "win32") return { applicable: false, ok: true, mode: "windows-acl" };
  const mode = fs.statSync(file).mode & 0o777;
  return { applicable: true, ok: (mode & 0o077) === 0, mode: mode.toString(8).padStart(3, "0") };
}

function publicConfig(config) {
  return {
    schema: config.schema,
    enabled: config.enabled,
    mode: config.mode,
    userId: config.userId,
    agentId: config.agentId,
    llm: { provider: config.llm.provider, baseUrl: config.llm.baseUrl, model: config.llm.model, keySource: config.llm.keySource },
    embedder: config.embedder,
    recall: config.recall,
    capture: config.capture,
  };
}

function publicRuntime(runtime) {
  return {
    schema: runtime.schema,
    sdkVersion: runtime.sdkVersion,
    python: runtime.python,
    serviceScript: runtime.serviceScript,
    wheelSha256: runtime.wheelSha256,
    installedAt: runtime.installedAt,
  };
}

function check(id, ok, message, details = undefined) {
  return { id, ok: Boolean(ok), level: ok ? "PASS" : "FAIL", message, ...(details ? { details } : {}) };
}

function memoryNextSteps(state) {
  const steps = [];
  if (!state.initialized) steps.push("pi-67 memory init");
  else {
    if (!state.config?.enabled) steps.push("pi-67 memory enable");
    if (!state.runtime) steps.push("pi-67 memory upgrade");
    if (!state.service) steps.push("pi-67 memory start");
    if (state.outbox.deadLetter > 0) steps.push("inspect ~/.hy-memory/pi67/outbox/dead-letter and run pi-67 memory doctor --deep");
  }
  return steps;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeMessage(error) {
  return String(error?.message || error || "unknown error").replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]").slice(0, 500);
}

function safeOutput(value) {
  return safeMessage(String(value || "").replace(/\s+/g, " ").trim());
}

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
