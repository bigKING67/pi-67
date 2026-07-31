import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CliError } from "./output.mjs";
import { replaceFileSafely } from "./xtalpi-config.mjs";
import {
  pipInstallArguments,
  readHyMemoryPythonLock,
  sanitizedPythonInstallerEnvironment,
  uvSyncArguments,
  validatePythonRuntimeManifest,
  validatePythonRuntimeManifestBinding,
  writePythonRuntimeManifest,
} from "./hy-memory-python-runtime.mjs";

export const HY_MEMORY_SDK_VERSION = "1.2.20";
export const HY_MEMORY_WHEEL_SHA256 = "9055a2b793e553aead5558c821f1a69667aac20838929f314c95bfd6c3bf3cc2";

const CONFIG_SCHEMA = "pi67-hy-memory-config/v1";
const SECRETS_SCHEMA = "pi67-hy-memory-secrets/v1";
const LEGACY_RUNTIME_SCHEMA = "pi67-hy-memory-runtime/v1";
const RUNTIME_SCHEMA = "pi67-hy-memory-runtime/v2";
const SERVICE_SCHEMA = "pi67-hy-memory-service/v1";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const POTENTIALLY_RETAINED_MEMORY_COPIES = Object.freeze([
  "history",
  "pipeline-trace",
  "pipeline-log",
  "reset-backups",
]);
const MANAGED_RUNTIME_PATTERN = /^hy-memory-(\d+\.\d+\.\d+)-pi67-([0-9a-f]{12})(?:-pydeps-([0-9a-f]{12}))?(?:-([0-9a-f]{12}))?$/;
const OUTBOX_LIMITS = Object.freeze({
  maxActiveJobs: 1_000,
  maxActiveBytes: 64 * 1024 * 1024,
  maxDeadLetterJobs: 500,
  maxDeadLetterBytes: 32 * 1024 * 1024,
  deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1_000,
});

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
    lifetimeLockFile: path.join(root, "runtime", "service-lifetime.lock"),
    lifetimeOwnerFile: path.join(root, "runtime", "service-owner.json"),
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
  const dependencyLock = readHyMemoryPythonLock(ctx.repoRoot, { hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256 });

  const config = defaultMemoryConfig();
  const plan = {
    schema: "pi67.memory-init-plan/v1",
    root: paths.root,
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python: "3.11",
    dependencyLock: { target: dependencyLock.target.id, sha256: dependencyLock.lockSha256 },
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
  const staged = await stageMemoryRuntime(ctx, options);
  return activateMemoryRuntime(options.paths || memoryPaths(options.home), staged.runtime);
}

export async function stageMemoryRuntime(ctx, options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  const source = path.join(ctx.repoRoot, "extensions", "pi-hy-memory", "service.py");
  if (!fs.existsSync(source)) throw new CliError(`Hy-Memory service source is missing: ${source}`);
  ensureStateDirectories(paths);

  const serviceHash = sha256File(source);
  const dependencyLock = readHyMemoryPythonLock(ctx.repoRoot, {
    requireQualified: options.requireQualifiedPythonLock !== false,
    targetId: options.pythonLockTarget,
    platform: options.platform,
    arch: options.arch,
    libc: options.libc,
    hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
  });
  const generation = memoryRuntimeGenerationName(serviceHash, {
    dependencyLockSha256: dependencyLock.lockSha256,
    force: Boolean(options.force),
  });
  const installRoot = path.join(paths.runtimeDir, generation);
  const serviceScript = path.join(installRoot, "service.py");
  const python = venvPython(path.join(installRoot, "venv"));
  const pythonRuntimeManifest = path.join(installRoot, "python-runtime.json");
  const runtimeBase = {
    schema: RUNTIME_SCHEMA,
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python,
    serviceScript,
    wrapperSha256: serviceHash,
    wheelSha256: HY_MEMORY_WHEEL_SHA256,
    dependencyLockId: dependencyLock.lockId,
    dependencyLockTarget: dependencyLock.target.id,
    dependencyLockSha256: dependencyLock.lockSha256,
    pythonRuntimeManifest,
  };

  if (!options.force && fs.existsSync(python) && fs.existsSync(serviceScript) && fs.existsSync(pythonRuntimeManifest)) {
    const pythonManifestSha256 = sha256File(pythonRuntimeManifest);
    const runtime = {
      ...runtimeBase,
      pythonRuntimeManifestSha256: pythonManifestSha256,
      installedAt: readJsonObject(pythonRuntimeManifest).createdAt,
    };
    validateManagedRuntime(runtime, paths);
    validatePythonRuntimeManifest(pythonRuntimeManifest, dependencyLock, HY_MEMORY_WHEEL_SHA256);
    verifyPythonRuntime(python, runtime);
    return { runtime, root: installRoot, created: false, reused: true };
  }
  if (!options.force && selectedRuntimeRoot(paths) === path.resolve(installRoot)) {
    throw new CliError("Hy-Memory selected runtime is incomplete; rerun `pi-67 memory upgrade --force`");
  }

  const createdNow = !fs.existsSync(installRoot);
  try {
    fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(serviceScript)) {
      const existingService = fs.lstatSync(serviceScript);
      if (!existingService.isFile() || existingService.isSymbolicLink()) {
        throw new CliError(`Hy-Memory service script must be a regular non-symlink file: ${serviceScript}`);
      }
    }
    const uv = commandAvailable("uv", ["--version"]);
    let installer;
    const installerEnv = sanitizedPythonInstallerEnvironment(process.env);
    if (uv) {
      installer = { kind: "uv", version: commandOutput("uv", ["--version"]).replace(/^uv\s+/, "").split(/\s+/)[0] };
      runChecked("uv", ["--no-config", "venv", "--python", "3.11", path.join(installRoot, "venv")], {
        timeoutMs: 10 * 60_000,
        env: installerEnv,
      });
      runChecked("uv", uvSyncArguments(dependencyLock, python), { timeoutMs: 30 * 60_000, env: installerEnv });
    } else {
      const creator = python311Creator();
      if (!creator) {
        throw new CliError("Python 3.11 is required. Install uv or Python 3.11, then rerun `pi-67 memory init`");
      }
      runChecked(creator.command, [...creator.prefix, "-m", "venv", path.join(installRoot, "venv")], {
        timeoutMs: 10 * 60_000,
        env: installerEnv,
      });
      installer = { kind: "pip", version: pipVersion(python, installerEnv) };
      runChecked(python, pipInstallArguments(dependencyLock), { timeoutMs: 30 * 60_000, env: installerEnv });
    }

    fs.copyFileSync(source, serviceScript);
    try {
      fs.chmodSync(serviceScript, 0o700);
    } catch {
      // Windows executable ACLs follow the user profile.
    }
    const inspected = writePythonRuntimeManifest({
      python,
      inspectorFile: dependencyLock.inspectorFile,
      outputFile: pythonRuntimeManifest,
      lock: dependencyLock,
      installer,
      hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
      env: installerEnv,
    });
    const runtime = {
      ...runtimeBase,
      pythonRuntimeManifestSha256: inspected.sha256,
      installedAt: inspected.manifest.createdAt,
    };
    validateManagedRuntime(runtime, paths);
    verifyPythonRuntime(python, runtime);
    return { runtime, root: installRoot, created: createdNow, reused: false };
  } catch (error) {
    if (createdNow && path.resolve(installRoot).startsWith(`${path.resolve(paths.runtimeDir)}${path.sep}`)) {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export function memoryRuntimeGenerationName(wrapperSha256, options = {}) {
  if (!/^[0-9a-f]{64}$/.test(wrapperSha256 || "")) throw new CliError("Hy-Memory wrapper SHA-256 is invalid");
  const dependencySuffix = options.dependencyLockSha256 === undefined
    ? ""
    : `-pydeps-${validatedSha256(options.dependencyLockSha256, "Hy-Memory dependency lock").slice(0, 12)}`;
  const base = `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}${dependencySuffix}`;
  if (!options.force) return base;
  const installationId = options.installationId || crypto.randomBytes(6).toString("hex");
  if (!/^[0-9a-f]{12}$/.test(installationId)) throw new CliError("Hy-Memory runtime installation identity is invalid");
  return `${base}-${installationId}`;
}

export function activateMemoryRuntime(paths, runtime) {
  const validated = validateManagedRuntime(runtime, paths);
  verifyPythonRuntime(validated.python, validated);
  writeJsonSecure(paths.runtimeFile, runtime);
  return readRuntime(paths);
}

export function captureRuntimeSelection(paths) {
  if (!fs.existsSync(paths.runtimeFile)) return { exists: false, bytes: null, sha256: null, runtime: null };
  const bytes = fs.readFileSync(paths.runtimeFile);
  return {
    exists: true,
    bytes,
    sha256: sha256Buffer(bytes),
    runtime: readRuntime(paths),
  };
}

export function restoreRuntimeSelection(paths, snapshot) {
  if (!snapshot?.exists) {
    try {
      fs.unlinkSync(paths.runtimeFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return null;
  }
  if (!Buffer.isBuffer(snapshot.bytes) || !/^[0-9a-f]{64}$/.test(snapshot.sha256 || "")) {
    throw new CliError("Hy-Memory runtime selection snapshot is invalid");
  }
  writeFileSecure(paths.runtimeFile, snapshot.bytes);
  const restored = fs.readFileSync(paths.runtimeFile);
  if (sha256Buffer(restored) !== snapshot.sha256) throw new CliError("Hy-Memory prior runtime selection was not restored exactly");
  return readRuntime(paths);
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
  const topology = inspectServiceTopology(paths);
  checks.push(check("service-ownership", topology.ok, topology.message, topology));

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

export function inventoryMemoryRuntimes(options = {}) {
  const paths = memoryPaths(options.home);
  const issues = [];
  let currentRoot = "";
  let runtimeMetadata = null;
  try {
    runtimeMetadata = readRuntimeMetadata(paths);
    currentRoot = managedRuntimeRoot(runtimeMetadata.serviceScript, paths.runtimeDir);
    validateManagedRuntime(runtimeMetadata, paths);
  } catch (error) {
    issues.push(`current runtime is unavailable or invalid: ${safeMessage(error)}`);
  }

  const discovered = [];
  let ignoredEntries = 0;
  try {
    for (const entry of fs.readdirSync(paths.runtimeDir, { withFileTypes: true })) {
      const match = entry.isDirectory() ? MANAGED_RUNTIME_PATTERN.exec(entry.name) : null;
      if (!match) {
        ignoredEntries += 1;
        continue;
      }
      const root = path.join(paths.runtimeDir, entry.name);
      const usage = directoryUsage(root);
      const stat = fs.statSync(root);
      const wrapper = inspectRuntimeWrapper(root, match[2]);
      const pythonManifest = inspectRuntimePythonManifest(root, match[3] || null);
      discovered.push({
        name: entry.name,
        root,
        sdkVersion: match[1],
        wrapperHashPrefix: match[2],
        dependencyLockStatus: match[3] ? "locked" : "legacy-unlocked",
        dependencyLockHashPrefix: match[3] || null,
        pythonRuntimeManifestPresent: pythonManifest.present,
        pythonRuntimeManifestValid: pythonManifest.valid,
        pythonRuntimeManifestSha256: pythonManifest.sha256,
        wrapperPresent: wrapper.present,
        wrapperSha256: wrapper.sha256,
        wrapperHashMatchesName: wrapper.hashMatchesName,
        pythonPresent: fs.existsSync(venvPython(path.join(root, "venv"))),
        sizeBytes: usage.bytes,
        sizeComplete: usage.complete,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        modifiedAtMs: stat.mtimeMs,
      });
    }
  } catch (error) {
    if (fs.existsSync(paths.runtimeDir)) issues.push(`runtime inventory failed: ${safeMessage(error)}`);
  }

  discovered.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
  const current = discovered.find((item) => sameFilesystemPath(item.root, currentRoot)) || null;
  if (currentRoot && !current) issues.push("current runtime metadata does not reference a managed generation");
  const currentPython = inspectCurrentRuntimePython(runtimeMetadata, current);
  if (current && !current.wrapperHashMatchesName) {
    issues.push("current runtime wrapper hash does not match its generation name");
  }
  if (current && !currentPython.present) issues.push("current runtime Python executable is missing");
  if (current && !currentPython.pathMatchesGeneration) {
    issues.push("current runtime Python metadata does not reference the selected generation");
  }
  const previous = current ? discovered.find((item) => item !== current) || null : null;
  const topology = inspectServiceTopology(paths);
  const serviceRunning = topology.serviceAlive || topology.ownerAlive;
  const generations = discovered.map((item) => {
    const protectedReasons = [];
    if (item === current) protectedReasons.push("current");
    if (item === previous) protectedReasons.push("previous");
    if (serviceRunning) protectedReasons.push("service-running");
    if (
      !item.wrapperHashMatchesName ||
      (item.dependencyLockStatus === "locked" && !item.pythonRuntimeManifestValid)
    ) {
      protectedReasons.push("integrity-invalid");
    }
    const { modifiedAtMs: _modifiedAtMs, ...publicItem } = item;
    return { ...publicItem, protectedReasons };
  });
  const currentGeneration = current ? generations.find((item) => item.name === current.name) || null : null;
  const previousGeneration = previous ? generations.find((item) => item.name === previous.name) || null : null;
  const selectionValid = Boolean(currentGeneration) && issues.length === 0;
  const pruneCandidates = selectionValid
    ? generations.filter((item) => item.protectedReasons.length === 0)
    : [];
  const knownSizes = generations.filter((item) => item.sizeComplete);

  return {
    schema: "pi67.memory-runtime-inventory/v1",
    root: paths.runtimeDir,
    currentRuntimeFile: paths.runtimeFile,
    serviceRunning,
    serviceTopology: topology.state,
    selectionValid,
    generationCount: generations.length,
    totalBytes: knownSizes.reduce((total, item) => total + item.sizeBytes, 0),
    totalBytesComplete: knownSizes.length === generations.length,
    currentPython,
    current: currentGeneration,
    previous: previousGeneration,
    pruneCandidates,
    generations,
    ignoredEntries,
    issues,
  };
}

export function planMemoryRuntimePrune(options = {}) {
  const inventory = inventoryMemoryRuntimes(options);
  const blockedReasons = ["deletion-not-implemented"];
  const readiness = [
    pruneReadinessCheck(
      "runtime-selection",
      inventory.selectionValid,
      "runtime-selection-invalid",
      "current metadata resolves to one intact managed generation",
    ),
    pruneReadinessCheck(
      "current-wrapper",
      Boolean(inventory.current?.wrapperPresent && inventory.current?.wrapperHashMatchesName),
      "current-wrapper-invalid",
      "current service.py SHA-256 matches the generation name",
    ),
    pruneReadinessCheck(
      "current-python",
      Boolean(inventory.currentPython.present && inventory.currentPython.pathMatchesGeneration),
      "current-python-invalid",
      "current Python executable exists at the managed generation path",
    ),
    pruneReadinessCheck(
      "rollback-generation",
      Boolean(
        inventory.previous?.wrapperPresent &&
        inventory.previous?.wrapperHashMatchesName &&
        inventory.previous?.pythonPresent &&
        (
          inventory.previous?.dependencyLockStatus === "legacy-unlocked" ||
          inventory.previous?.pythonRuntimeManifestValid
        )
      ),
      "rollback-generation-unavailable",
      "one intact previous generation remains available for rollback",
    ),
    pruneReadinessCheck(
      "size-scan",
      inventory.totalBytesComplete,
      "size-scan-incomplete",
      "all managed generation sizes were scanned completely",
    ),
    pruneReadinessCheck(
      "service-stopped",
      !inventory.serviceRunning,
      "service-running",
      "no live service or lifetime owner references a generation",
    ),
  ];
  for (const item of readiness) {
    if (!item.ok && !blockedReasons.includes(item.blockedReason)) blockedReasons.push(item.blockedReason);
  }
  const identity = runtimePrunePlanIdentity(inventory);
  return {
    schema: "pi67.memory-runtime-prune-plan/v1",
    planId: `sha256:${sha256Text(JSON.stringify(identity))}`,
    identity,
    dryRun: true,
    executable: false,
    preconditionsReady: readiness.every((item) => item.ok),
    readiness,
    root: inventory.root,
    current: inventory.current,
    previous: inventory.previous,
    wouldKeep: inventory.generations.filter((item) => item.protectedReasons.length > 0),
    wouldDelete: inventory.pruneCandidates,
    reclaimableBytes: inventory.pruneCandidates.reduce((total, item) => total + item.sizeBytes, 0),
    blockedReasons,
    issues: inventory.issues,
  };
}

export async function doctorMemory(ctx, options = {}) {
  const paths = memoryPaths(options.home);
  let status = await memoryStatus(ctx, { home: options.home });
  const checks = [...status.checks];
  let probe = null;
  if (status.runtime) {
    try {
      verifyPythonRuntime(status.runtime.python, status.runtime);
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
  const runtime = readRuntime(paths);
  const existing = await tryServiceInfo(paths);
  if (existing) return { running: true, started: false, info: existing };

  let topology = inspectServiceTopology(paths);
  if (topology.serviceAlive && topology.state !== "owned") {
    throw new CliError(`Hy-Memory service ownership conflict: ${topology.message}`);
  }
  if (topology.ownerAlive) {
    const info = await waitForService(paths, options.timeoutMs || 45000);
    if (info) return { running: true, started: false, info };
    topology = inspectServiceTopology(paths);
    throw new CliError(`Hy-Memory service ownership conflict: ${topology.message}`);
  }

  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const lock = acquireStartLock(paths);
  if (!lock.acquired) {
    const info = await waitForService(paths, options.timeoutMs || 45000);
    if (info) return { running: true, started: false, info };
    throw new CliError("Hy-Memory service start is already in progress but did not become ready");
  }

  try {
    return await startMemoryServiceLocked(ctx, {
      paths,
      config,
      runtime,
      timeoutMs: options.timeoutMs || 45000,
    });
  } finally {
    releaseStartLock(paths, lock.token);
  }
}

async function startMemoryServiceLocked(ctx, { paths, config, runtime, timeoutMs }) {
  const selected = readRuntime(paths);
  if (!sameRuntimeIdentity(selected, validateManagedRuntime(runtime, paths))) {
    throw new CliError("Hy-Memory selected runtime changed before service start");
  }
  const rechecked = await tryServiceInfo(paths);
  if (rechecked) return { running: true, started: false, info: rechecked };
  const topology = inspectServiceTopology(paths);
  if (topology.ownerAlive || topology.serviceAlive) {
    throw new CliError(`Hy-Memory service ownership conflict: ${topology.message}`);
  }
  const secrets = readSecrets(paths);
  const llmKey = secrets.llmApiKey || readPiAuthCredential(ctx.agentDir, config.llm.keySource.provider);
  const child = spawn(selected.python, [selected.serviceScript, "--root", paths.root, "--port", "0"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: buildMemoryServiceEnvironment({
      llmKey,
      embeddingKey: secrets.embeddingApiKey,
      token: secrets.serviceBearerToken,
      dataDir: paths.dataDir,
    }),
  });
  try {
    await waitForSpawn(child);
    child.unref();
    const info = await waitForService(paths, timeoutMs);
    if (!info) {
      const quiesced = await terminateSpawnedProcess(child, 5000);
      const error = new CliError("Hy-Memory service did not become ready; inspect ~/.hy-memory/pi67/logs/service.log");
      error.serviceQuiesced = quiesced;
      throw error;
    }
    return { running: true, started: true, info };
  } catch (error) {
    const failure = error instanceof Error ? error : new CliError(safeMessage(error));
    if (failure.serviceQuiesced === undefined) failure.serviceQuiesced = await terminateSpawnedProcess(child, 5000);
    throw failure;
  }
}

export async function stopMemoryService(options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  const info = await tryServiceInfo(paths);
  if (!info) {
    const topology = inspectServiceTopology(paths);
    if (topology.serviceAlive || topology.ownerAlive) {
      throw new CliError(`Hy-Memory service ownership conflict: ${topology.message}`);
    }
    return { running: false, stopped: false };
  }
  await memoryServiceRequest(paths, "POST", "/v1/shutdown", {}, 10000);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!await tryServiceInfo(paths)) return { running: false, stopped: true, previousPid: info.pid };
    await sleep(100);
  }
  throw new CliError("Hy-Memory service acknowledged shutdown but is still running");
}

export async function restartMemoryService(ctx, options = {}) {
  const paths = options.paths || memoryPaths(options.home);
  readRuntime(paths);
  await stopMemoryService({ ...options, paths });
  return await startMemoryService(ctx, { ...options, paths });
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
    const dependencyLock = readHyMemoryPythonLock(ctx.repoRoot, { hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256 });
    return {
      schema: "pi67.memory-upgrade/v1",
      dryRun: true,
      root: paths.root,
      sdkVersion: HY_MEMORY_SDK_VERSION,
      dependencyLock: { target: dependencyLock.target.id, sha256: dependencyLock.lockSha256 },
      preserves: ["config.json", "secrets.json", "data/", "outbox/", "operations/"],
      transaction: ["stage", "lock", "stop-if-running", "activate", "restart-if-running", "rollback-on-failure"],
    };
  }
  return await executeDefaultMemoryUpgrade(ctx, {
    paths,
    force: Boolean(options.force),
    timeoutMs: options.timeoutMs || 45000,
  });
}

export function createMemoryUpgradeExecutor(ports) {
  const required = [
    "stageRuntime", "acquireLock", "releaseLock", "captureSelection", "inspectServiceState",
    "stopService", "activateRuntime", "restoreSelection", "startSelectedRuntime",
  ];
  for (const name of required) {
    if (typeof ports?.[name] !== "function") throw new TypeError(`memory upgrade port '${name}' is required`);
  }

  return async function executeMemoryUpgrade(ctx, options) {
    let staged;
    try {
      staged = await ports.stageRuntime(ctx, { paths: options.paths, force: options.force });
    } catch (error) {
      return failedUpgradeReceipt(createUpgradeReceipt(), "STAGE", error);
    }

    const receipt = createUpgradeReceipt(staged.runtime);
    let lock;
    try {
      lock = ports.acquireLock(options.paths);
    } catch (error) {
      return failedUpgradeReceipt(receipt, "LOCK", error);
    }
    if (!lock?.acquired) {
      return failedUpgradeReceipt(receipt, "LOCK", new CliError("Hy-Memory service start or upgrade is already in progress"));
    }

    let snapshot;
    let serviceBefore;
    try {
      try {
        snapshot = await ports.captureSelection(options.paths);
      } catch (error) {
        return failedUpgradeReceipt(receipt, "SNAPSHOT", error);
      }
      try {
        serviceBefore = await ports.inspectServiceState(options.paths);
        receipt.serviceBefore = serviceBefore.running ? "running" : "stopped";
      } catch (error) {
        return failedUpgradeReceipt(receipt, "SERVICE_STATE", error);
      }

      if (serviceBefore.running) {
        try {
          await ports.stopService({ paths: options.paths });
          receipt.stop.completed = true;
        } catch (error) {
          return failedUpgradeReceipt(receipt, "STOP", error);
        }
      }

      try {
        receipt.activation.attempted = true;
        const activated = await ports.activateRuntime(options.paths, staged.runtime);
        receipt.activation.completed = true;
        receipt.activation.selectionVerified = sameRuntimeIdentity(activated, staged.runtime);
        if (!receipt.activation.selectionVerified) throw new CliError("Hy-Memory target runtime selection could not be verified");

        if (serviceBefore.running) {
          await ports.startSelectedRuntime(ctx, {
            paths: options.paths,
            runtime: activated,
            timeoutMs: options.timeoutMs,
          });
          receipt.restarted = true;
          receipt.readiness.completed = true;
        }

        receipt.success = true;
        receipt.upgraded = true;
        receipt.changed = true;
        receipt.phase = "COMPLETED";
        receipt.runtime = publicRuntime(activated);
        return receipt;
      } catch (error) {
        const failedPhase = receipt.activation.completed ? "TARGET_READINESS" : "ACTIVATE";
        failedUpgradeReceipt(receipt, failedPhase, error);
        receipt.rollback.attempted = true;
        if (error?.serviceQuiesced === false) {
          receipt.rollback.failures.push({
            phase: "ROLLBACK_QUIESCE",
            message: "the staged service process could not be proven stopped",
          });
          return receipt;
        }

        try {
          const restored = await ports.restoreSelection(options.paths, snapshot);
          receipt.rollback.selectionRestored = snapshot.exists
            ? sameRuntimeIdentity(restored, snapshot.runtime)
            : restored === null;
          if (!receipt.rollback.selectionRestored) throw new CliError("prior runtime selection identity did not match after rollback");
        } catch (rollbackError) {
          receipt.rollback.failures.push({ phase: "ROLLBACK_SELECTION", message: safeMessage(rollbackError) });
          return receipt;
        }

        if (serviceBefore.running) {
          receipt.rollback.serviceRestoreAttempted = true;
          try {
            await ports.startSelectedRuntime(ctx, {
              paths: options.paths,
              runtime: snapshot.runtime,
              timeoutMs: options.timeoutMs,
            });
            receipt.rollback.serviceRestored = true;
          } catch (rollbackError) {
            receipt.rollback.failures.push({ phase: "ROLLBACK_RESTART", message: safeMessage(rollbackError) });
          }
        }
        return receipt;
      }
    } finally {
      ports.releaseLock(options.paths, lock.token);
    }
  };
}

const executeDefaultMemoryUpgrade = createMemoryUpgradeExecutor(Object.freeze({
  stageRuntime: stageMemoryRuntime,
  acquireLock: acquireStartLock,
  releaseLock: releaseStartLock,
  captureSelection: captureRuntimeSelection,
  inspectServiceState: inspectUpgradeServiceState,
  stopService: stopMemoryService,
  activateRuntime: activateMemoryRuntime,
  restoreSelection: restoreRuntimeSelection,
  startSelectedRuntime: async (ctx, options) => await startMemoryServiceLocked(ctx, {
    ...options,
    config: readConfig(options.paths),
  }),
}));

function createUpgradeReceipt(runtime = null) {
  return {
    schema: "pi67.memory-upgrade/v1",
    success: false,
    upgraded: false,
    changed: false,
    phase: "STAGE",
    serviceBefore: "unknown",
    runtime: runtime ? publicRuntime(runtime) : null,
    restarted: false,
    stop: { completed: false },
    activation: { attempted: false, completed: false, selectionVerified: false },
    readiness: { completed: false },
    rollback: {
      attempted: false,
      selectionRestored: false,
      serviceRestoreAttempted: false,
      serviceRestored: false,
      failures: [],
    },
    error: null,
    nextSteps: [],
  };
}

function failedUpgradeReceipt(receipt, phase, error) {
  receipt.success = false;
  receipt.upgraded = false;
  receipt.phase = phase;
  receipt.error = safeMessage(error);
  receipt.nextSteps = ["pi-67 memory status", "pi-67 memory doctor"];
  return receipt;
}

export async function forgetMemory(ctx, memoryId, options = {}) {
  if (!options.yes) throw new CliError("active memory deletion requires --yes", 2);
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(memoryId || "")) throw new CliError("memory ID is invalid", 2);
  const paths = memoryPaths(options.home);
  await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  const result = await memoryServiceRequest(
    paths,
    "DELETE",
    `/v1/memories/${encodeURIComponent(memoryId)}`,
    undefined,
    30000,
  );
  return activeDeleteResult(result);
}

export async function digestMemory(ctx, options = {}) {
  if (!options.yes) throw new CliError("System 2 digest is non-idempotent and requires --yes", 2);
  const paths = memoryPaths(options.home);
  await startMemoryService(ctx, { paths, timeoutMs: 45000 });
  return await memoryServiceRequest(
    paths,
    "POST",
    "/v1/digest",
    { operationId: crypto.randomBytes(32).toString("hex") },
    options.timeoutMs || 15 * 60_000,
  );
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

function readRuntimeMetadata(paths) {
  const runtime = readJsonObject(paths.runtimeFile);
  if (
    ![LEGACY_RUNTIME_SCHEMA, RUNTIME_SCHEMA].includes(runtime.schema) || runtime.sdkVersion !== HY_MEMORY_SDK_VERSION ||
    typeof runtime.python !== "string" || typeof runtime.serviceScript !== "string" ||
    typeof runtime.installedAt !== "string" || !runtime.installedAt ||
    (runtime.wrapperSha256 !== undefined && !/^[0-9a-f]{64}$/.test(runtime.wrapperSha256)) ||
    runtime.wheelSha256 !== HY_MEMORY_WHEEL_SHA256
  ) throw new CliError(`Hy-Memory runtime metadata is invalid in ${paths.runtimeFile}`);
  if (
    runtime.schema === RUNTIME_SCHEMA &&
    (
      runtime.dependencyLockId !== `sha256:${runtime.dependencyLockSha256}` ||
      typeof runtime.dependencyLockTarget !== "string" || !runtime.dependencyLockTarget ||
      !/^[0-9a-f]{64}$/.test(runtime.dependencyLockSha256 || "") ||
      typeof runtime.pythonRuntimeManifest !== "string" ||
      !/^[0-9a-f]{64}$/.test(runtime.pythonRuntimeManifestSha256 || "")
    )
  ) throw new CliError(`Hy-Memory locked runtime metadata is invalid in ${paths.runtimeFile}`);
  return runtime;
}

function readRuntime(paths) {
  return validateManagedRuntime(readRuntimeMetadata(paths), paths);
}

function validateManagedRuntime(runtime, paths) {
  managedRuntimeRoot(runtime.serviceScript, paths.runtimeDir);
  const runtimeRoot = path.dirname(path.resolve(runtime.serviceScript));
  const generationName = path.basename(runtimeRoot);
  const generation = MANAGED_RUNTIME_PATTERN.exec(generationName);
  if (!generation || generation[1] !== runtime.sdkVersion) {
    throw new CliError("Hy-Memory runtime SDK version does not match its managed generation");
  }

  const expectedServiceScript = path.join(runtimeRoot, "service.py");
  if (path.resolve(runtime.serviceScript) !== path.resolve(expectedServiceScript)) {
    throw new CliError("Hy-Memory runtime service path does not match its managed generation");
  }
  const wrapper = inspectRuntimeWrapper(runtimeRoot, generation[2]);
  if (!wrapper.present) {
    throw new CliError(`Hy-Memory service script must be a regular non-symlink file: ${expectedServiceScript}`);
  }
  if (!wrapper.hashMatchesName) {
    throw new CliError("Hy-Memory runtime wrapper SHA-256 does not match its managed generation");
  }
  if (runtime.wrapperSha256 !== undefined && runtime.wrapperSha256 !== wrapper.sha256) {
    throw new CliError("Hy-Memory runtime wrapper SHA-256 does not match runtime metadata");
  }

  const expectedPython = venvPython(path.join(runtimeRoot, "venv"));
  if (path.resolve(runtime.python) !== path.resolve(expectedPython)) {
    throw new CliError("Hy-Memory Python path does not match its managed generation");
  }
  if (!fs.existsSync(expectedPython)) throw new CliError(`Python runtime is missing: ${expectedPython}`);

  if (runtime.schema === RUNTIME_SCHEMA) {
    if (generation[3] !== runtime.dependencyLockSha256.slice(0, 12)) {
      throw new CliError("Hy-Memory dependency lock SHA-256 does not match its managed generation");
    }
    const expectedManifest = path.join(runtimeRoot, "python-runtime.json");
    if (path.resolve(runtime.pythonRuntimeManifest) !== path.resolve(expectedManifest)) {
      throw new CliError("Hy-Memory Python runtime manifest path does not match its managed generation");
    }
    let manifestStat;
    try {
      manifestStat = fs.lstatSync(expectedManifest);
    } catch {
      throw new CliError(`Hy-Memory Python runtime manifest is missing: ${expectedManifest}`);
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new CliError(`Hy-Memory Python runtime manifest must be a regular non-symlink file: ${expectedManifest}`);
    }
    if (sha256File(expectedManifest) !== runtime.pythonRuntimeManifestSha256) {
      throw new CliError("Hy-Memory Python runtime manifest SHA-256 does not match runtime metadata");
    }
    validatePythonRuntimeManifestBinding(expectedManifest, {
      lockId: runtime.dependencyLockId,
      lockTarget: runtime.dependencyLockTarget,
      lockSha256: runtime.dependencyLockSha256,
      hyMemoryVersion: HY_MEMORY_SDK_VERSION,
      hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
    });
  } else if (generation[3]) {
    throw new CliError("legacy Hy-Memory runtime metadata cannot select a dependency-locked generation");
  }

  return { ...runtime, wrapperSha256: wrapper.sha256 };
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
  writeFileSecure(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function writeFileSecure(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
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

function verifyPythonRuntime(python, runtime = null) {
  if (!fs.existsSync(python)) throw new CliError(`Python runtime is missing: ${python}`);
  const script = [
    "import importlib.metadata,json,sys",
    "norm=lambda value: '-'.join(filter(None,value.lower().replace('_','-').replace('.','-').split('-')))",
    "items=sorted([{'name':norm(d.metadata.get('Name','')),'version':str(d.version)} for d in importlib.metadata.distributions()],key=lambda item:item['name'])",
    "print(json.dumps({'python':list(sys.version_info[:2]),'hyMemory':importlib.metadata.version('hy-memory'),'distributions':items},separators=(',',':')))",
  ].join(";");
  const result = spawnSync(python, ["-c", script], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  let inspected;
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    inspected = null;
  }
  if (result.status !== 0 || inspected?.hyMemory !== HY_MEMORY_SDK_VERSION || inspected?.python?.join(".") !== "3.11") {
    throw new CliError(`Hy-Memory Python 3.11 runtime verification failed: ${safeOutput(result.stderr || result.stdout)}`);
  }
  if (runtime?.schema === RUNTIME_SCHEMA) {
    const recorded = readJsonObject(runtime.pythonRuntimeManifest);
    if (JSON.stringify(inspected.distributions) !== JSON.stringify(recorded.distributions)) {
      throw new CliError("Hy-Memory Python runtime installed closure differs from python-runtime.json");
    }
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    windowsHide: true,
    env: options.env || process.env,
  });
  if (result.error) throw new CliError(`failed to run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`${command} exited with ${result.status}: ${safeOutput(result.stderr || result.stdout)}`);
  return result;
}

function commandOutput(command, args, options = {}) {
  const result = runChecked(command, args, { timeoutMs: options.timeoutMs || 10_000, env: options.env });
  return String(result.stdout || "").trim();
}

function pipVersion(python, env) {
  const output = commandOutput(python, ["-m", "pip", "--version"], { env });
  const match = /^pip\s+([^\s]+)/.exec(output);
  if (!match) throw new CliError("could not determine pip installer version");
  return match[1];
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
    if (Number(response.headers.get("content-length") || 0) > MAX_HTTP_BYTES) throw new CliError("Hy-Memory response is too large");
    const text = await readResponseTextBounded(response, MAX_HTTP_BYTES);
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new CliError(`Hy-Memory service returned invalid JSON (HTTP ${response.status})`);
    }
    if (isOperationReceipt(value)) return value;
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

async function inspectUpgradeServiceState(paths) {
  const topology = inspectServiceTopology(paths);
  if (topology.state === "stopped" || topology.state === "stale") {
    return { running: false, topology: topology.state, info: null };
  }
  if (topology.state !== "owned") {
    throw new CliError(`Hy-Memory service ownership conflict: ${topology.message}`);
  }
  const info = await memoryServiceRequest(paths, "GET", "/v1/info", undefined, 1500);
  return { running: true, topology: topology.state, info };
}

function validateServiceIdentity(info, service, paths) {
  if (
    !info || info.schema !== SERVICE_SCHEMA || info.instanceId !== service.instanceId || info.pid !== service.pid ||
    canonicalFilesystemPath(String(info.root || "")) !== canonicalFilesystemPath(paths.root) ||
    canonicalFilesystemPath(String(info.dataDir || "")) !== canonicalFilesystemPath(paths.dataDir)
  ) throw new CliError("Hy-Memory service identity does not match this installation");
  const owner = readLifetimeOwner(paths);
  if (
    !owner || !processExists(owner.pid) || owner.pid !== service.pid || owner.instanceId !== service.instanceId ||
    canonicalFilesystemPath(String(owner.root || "")) !== canonicalFilesystemPath(paths.root)
  ) throw new CliError("Hy-Memory service has no matching live lifetime owner");
}

function inspectServiceTopology(paths) {
  const service = readOptionalJsonObject(paths.serviceFile);
  const owner = readLifetimeOwner(paths);
  const serviceAlive = Number.isInteger(service?.pid) && processExists(service.pid);
  const ownerAlive = Boolean(owner && processExists(owner.pid));
  const sameOwner = Boolean(
    serviceAlive && ownerAlive && service.pid === owner.pid && service.instanceId === owner.instanceId &&
    canonicalFilesystemPath(String(service.root || "")) === canonicalFilesystemPath(paths.root) &&
    canonicalFilesystemPath(String(owner.root || "")) === canonicalFilesystemPath(paths.root),
  );
  if (sameOwner) {
    return { ok: true, state: "owned", message: `service PID ${service.pid} holds lifetime ownership`, ownerAlive, serviceAlive };
  }
  if (serviceAlive && ownerAlive) {
    return {
      ok: false,
      state: "duplicate",
      message: `service PID ${service.pid} conflicts with lifetime owner PID ${owner.pid}`,
      ownerAlive,
      serviceAlive,
      pids: [...new Set([service.pid, owner.pid])],
    };
  }
  if (serviceAlive) {
    return {
      ok: false,
      state: "orphan-service",
      message: `service PID ${service.pid} is alive without lifetime ownership`,
      ownerAlive,
      serviceAlive,
      pids: [service.pid],
    };
  }
  if (ownerAlive) {
    return {
      ok: false,
      state: "orphan-owner",
      message: `lifetime owner PID ${owner.pid} is alive without matching service metadata`,
      ownerAlive,
      serviceAlive,
      pids: [owner.pid],
    };
  }
  if (service || owner) {
    return { ok: false, state: "stale", message: "stale service ownership metadata is present", ownerAlive, serviceAlive };
  }
  return { ok: true, state: "stopped", message: "no live service owner is present", ownerAlive, serviceAlive };
}

function readLifetimeOwner(paths) {
  const value = readOptionalJsonObject(paths.lifetimeOwnerFile);
  if (
    !value || value.schema !== SERVICE_SCHEMA || !Number.isInteger(value.pid) ||
    typeof value.instanceId !== "string" || typeof value.root !== "string"
  ) return null;
  return value;
}

function readOptionalJsonObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalFilesystemPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function managedRuntimeRoot(serviceScript, runtimeDir) {
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const candidate = path.dirname(path.resolve(serviceScript));
  if (path.dirname(candidate) !== resolvedRuntimeDir || !MANAGED_RUNTIME_PATTERN.test(path.basename(candidate))) {
    throw new CliError("current runtime service path is outside a managed generation");
  }
  const canonicalRuntimeDir = canonicalFilesystemPath(resolvedRuntimeDir);
  const canonicalCandidate = canonicalFilesystemPath(candidate);
  if (path.dirname(canonicalCandidate) !== canonicalRuntimeDir) {
    throw new CliError("current runtime generation resolves outside the runtime root");
  }
  return canonicalCandidate;
}

function sameFilesystemPath(left, right) {
  if (!left || !right) return false;
  return canonicalFilesystemPath(left) === canonicalFilesystemPath(right);
}

function inspectRuntimeWrapper(root, expectedHashPrefix) {
  const file = path.join(root, "service.py");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { present: false, sha256: null, hashMatchesName: false };
    const sha256 = sha256File(file);
    return { present: true, sha256, hashMatchesName: sha256.startsWith(expectedHashPrefix) };
  } catch {
    return { present: false, sha256: null, hashMatchesName: false };
  }
}

function inspectRuntimePythonManifest(root, dependencyLockHashPrefix) {
  if (!dependencyLockHashPrefix) return { present: false, valid: false, sha256: null };
  const file = path.join(root, "python-runtime.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { present: false, valid: false, sha256: null };
    const value = readJsonObject(file);
    const lockSha256 = value.lock?.sha256;
    const valid = value.schema === "pi67.hy-memory-python-runtime.v1" &&
      typeof lockSha256 === "string" && lockSha256.startsWith(dependencyLockHashPrefix) &&
      value.lock?.id === `sha256:${lockSha256}` &&
      typeof value.lock?.target === "string" && value.lock.target &&
      value.policy?.requireHashes === true && value.policy?.onlyBinary === true &&
      value.hyMemory?.version === HY_MEMORY_SDK_VERSION &&
      value.hyMemory?.wheelSha256 === HY_MEMORY_WHEEL_SHA256;
    return { present: true, valid: Boolean(valid), sha256: sha256File(file) };
  } catch {
    return { present: false, valid: false, sha256: null };
  }
}

function inspectCurrentRuntimePython(runtime, current) {
  if (!runtime || !current) return { path: null, expectedPath: null, present: false, pathMatchesGeneration: false };
  const expectedPath = venvPython(path.join(current.root, "venv"));
  return {
    path: runtime.python,
    expectedPath,
    present: fs.existsSync(runtime.python),
    // A venv Python may legitimately be a symlink to the base interpreter.
    pathMatchesGeneration: path.resolve(runtime.python) === path.resolve(expectedPath),
  };
}

function pruneReadinessCheck(id, ok, blockedReason, message) {
  return { id, ok: Boolean(ok), level: ok ? "PASS" : "FAIL", blockedReason, message };
}

function runtimePrunePlanIdentity(inventory) {
  const generationIdentity = (item) => item ? {
    name: item.name,
    sdkVersion: item.sdkVersion,
    wrapperSha256: item.wrapperSha256,
    dependencyLockHashPrefix: item.dependencyLockHashPrefix,
    pythonRuntimeManifestSha256: item.pythonRuntimeManifestSha256,
    pythonPresent: item.pythonPresent,
    sizeBytes: item.sizeBytes,
    sizeComplete: item.sizeComplete,
  } : null;
  return {
    schema: "pi67.memory-runtime-prune-plan-identity/v1",
    rootIdentity: `sha256:${sha256Text(canonicalFilesystemPath(inventory.root))}`,
    serviceRunning: inventory.serviceRunning,
    serviceTopology: inventory.serviceTopology,
    currentPython: {
      present: inventory.currentPython.present,
      pathMatchesGeneration: inventory.currentPython.pathMatchesGeneration,
    },
    current: generationIdentity(inventory.current),
    previous: generationIdentity(inventory.previous),
    generations: inventory.generations
      .map((item) => ({ ...generationIdentity(item), protectedReasons: [...item.protectedReasons].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    candidates: inventory.pruneCandidates
      .map(generationIdentity)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function directoryUsage(root) {
  const pending = [root];
  let bytes = 0;
  let complete = true;
  while (pending.length > 0) {
    const dir = pending.pop();
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) bytes += fs.statSync(target).size;
      }
    } catch {
      complete = false;
    }
  }
  return { bytes, complete };
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
  if (existing && processExists(existing.pid)) {
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

async function readResponseTextBounded(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new CliError("Hy-Memory response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function buildMemoryServiceEnvironment(input) {
  const allowed = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA"];
  const env = {};
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
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
    PI67_HY_MEMORY_LLM_API_KEY: input.llmKey,
    PI67_HY_MEMORY_EMBEDDING_API_KEY: input.embeddingKey,
    PI67_HY_MEMORY_SERVICE_TOKEN: input.token,
  };
}

function outboxCounts(paths) {
  const pending = directoryJsonUsage(paths.pendingDir);
  const processing = directoryJsonUsage(paths.processingDir);
  const deadLetter = directoryJsonUsage(paths.deadLetterDir);
  const activeBytes = pending.bytes + processing.bytes;
  return {
    pending: pending.jobs,
    processing: processing.jobs,
    deadLetter: deadLetter.jobs,
    activeBytes,
    deadLetterBytes: deadLetter.bytes,
    saturated: pending.jobs + processing.jobs >= OUTBOX_LIMITS.maxActiveJobs || activeBytes >= OUTBOX_LIMITS.maxActiveBytes,
    limits: { ...OUTBOX_LIMITS },
  };
}

function directoryJsonUsage(dir) {
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
    wrapperSha256: runtime.wrapperSha256,
    wheelSha256: runtime.wheelSha256,
    dependencyLockId: runtime.dependencyLockId,
    dependencyLockTarget: runtime.dependencyLockTarget,
    dependencyLockSha256: runtime.dependencyLockSha256,
    pythonRuntimeManifest: runtime.pythonRuntimeManifest,
    pythonRuntimeManifestSha256: runtime.pythonRuntimeManifestSha256,
    installedAt: runtime.installedAt,
  };
}

function activeDeleteResult(value) {
  if (isOperationReceipt(value)) return value;
  const result = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
  return {
    ...result,
    activeDeleted: Number.isInteger(result.deleted_count) && result.deleted_count > 0,
    purgeComplete: false,
    retainedCopies: [...POTENTIALLY_RETAINED_MEMORY_COPIES],
  };
}

function isOperationReceipt(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    value.schema === "pi67-hy-memory-operation/v1" &&
    typeof value.operationId === "string" &&
    typeof value.state === "string" &&
    typeof value.statusPath === "string",
  );
}

function check(id, ok, message, details = undefined) {
  return { id, ok: Boolean(ok), level: ok ? "PASS" : "FAIL", message, ...(details ? { details } : {}) };
}

function memoryNextSteps(state) {
  const steps = [];
  if (!state.config && !state.secrets && !state.runtime) {
    steps.push("pi-67 memory init");
  } else if (!state.config || !state.secrets) {
    steps.push("pi-67 memory doctor");
  } else {
    if (!state.config?.enabled) steps.push("pi-67 memory enable");
    if (!state.runtime) steps.push("pi-67 memory upgrade --force");
    if (!state.service) steps.push("pi-67 memory start");
    if (state.outbox.saturated) steps.push("pi-67 memory flush");
    if (state.outbox.deadLetter > 0) steps.push("inspect ~/.hy-memory/pi67/outbox/dead-letter and run pi-67 memory doctor --deep");
  }
  return steps;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validatedSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value || "")) throw new CliError(`${label} SHA-256 is invalid`);
  return value;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
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

function sameRuntimeIdentity(left, right) {
  return Boolean(
    left && right &&
    left.schema === right.schema &&
    left.sdkVersion === right.sdkVersion &&
    left.wheelSha256 === right.wheelSha256 &&
    left.wrapperSha256 === right.wrapperSha256 &&
    left.dependencyLockSha256 === right.dependencyLockSha256 &&
    sameFilesystemPath(left.python, right.python) &&
    sameFilesystemPath(left.serviceScript, right.serviceScript),
  );
}

function selectedRuntimeRoot(paths) {
  try {
    return path.dirname(path.resolve(readRuntimeMetadata(paths).serviceScript));
  } catch {
    return "";
  }
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function terminateSpawnedProcess(child, timeoutMs) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || !processExists(pid)) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await sleep(100);
  }
  return !processExists(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
