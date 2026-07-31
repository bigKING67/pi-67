import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliError } from "./output.mjs";

export const HY_MEMORY_PYTHON_LOCK_SCHEMA = "pi67.hy-memory-python-lock.v1";
export const HY_MEMORY_PYTHON_RUNTIME_SCHEMA = "pi67.hy-memory-python-runtime.v1";
export const HY_MEMORY_PYTHON_VERSION = "3.11";

const HY_MEMORY_NAME = "hy-memory";
const LANGDETECT_NAME = "langdetect";
const LANGDETECT_WHEEL_SHA256 = "bcf5cd95ea915a79decd982f25fd6269e219f2b2247f8588dd114663913c7000";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_REQUIREMENT_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\]+)\s*\\?$/;
const INSTALLER_ENV_DENYLIST = new Set([
  "PIP_CONFIG_FILE",
  "PIP_EXTRA_INDEX_URL",
  "PIP_FIND_LINKS",
  "PIP_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "UV_EXTRA_INDEX_URL",
  "UV_FIND_LINKS",
  "UV_INDEX",
  "UV_INDEX_URL",
  "UV_NO_VERIFY_HASHES",
]);
const PIP_BOOTSTRAP_DISTRIBUTIONS = new Set(["pip", "setuptools", "wheel"]);

export function detectHyMemoryPythonTarget(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const libc = platform === "linux" ? (options.libc || detectLinuxLibc()) : null;

  if (platform === "darwin" && arch === "arm64") return "cp311-macos-arm64";
  if (platform === "linux" && arch === "x64" && libc === "glibc") return "cp311-manylinux_2_28-x64";
  if (platform === "win32" && arch === "x64") return "cp311-windows-x64";
  const suffix = platform === "linux" ? `${platform}-${arch}-${libc || "unknown-libc"}` : `${platform}-${arch}`;
  throw new CliError(`Hy-Memory Python runtime is not qualified for ${suffix}`);
}

export function readHyMemoryPythonLock(repoRoot, options = {}) {
  const pythonRoot = path.join(repoRoot, "extensions", "pi-hy-memory", "python");
  const manifestFile = path.join(pythonRoot, "lock-manifest.json");
  const manifest = readJsonObject(manifestFile);
  validateLockManifestHeader(manifest, manifestFile);

  const requirementsFile = resolveRegularFile(pythonRoot, manifest.requirementsInput.file, "requirements input");
  assertFileHash(requirementsFile, manifest.requirementsInput.sha256, "Hy-Memory Python requirements input");

  for (const artifact of manifest.vendorArtifacts) {
    if (
      !artifact || typeof artifact !== "object" ||
      !isSha256(artifact.sha256) || !isSha256(artifact.provenanceSha256)
    ) {
      throw new CliError(`Hy-Memory Python vendor artifact metadata is invalid in ${manifestFile}`);
    }
    const artifactFile = resolveRegularFile(pythonRoot, artifact.file, "vendor artifact");
    assertFileHash(artifactFile, artifact.sha256, "Hy-Memory Python vendor artifact");
    const provenanceFile = resolveRegularFile(pythonRoot, artifact.provenance, "vendor provenance");
    assertFileHash(provenanceFile, artifact.provenanceSha256, "Hy-Memory Python vendor provenance");
  }

  const targetId = options.targetId || detectHyMemoryPythonTarget(options);
  const matches = manifest.targets.filter((item) => item?.id === targetId);
  if (matches.length !== 1) throw new CliError(`Hy-Memory Python lock target is unavailable or ambiguous: ${targetId}`);
  const target = matches[0];
  validateLockTarget(target, manifestFile);
  if (options.requireQualified !== false && target.qualified !== true) {
    throw new CliError(`Hy-Memory Python runtime target has not passed native clean-install qualification: ${targetId}`);
  }

  const lockFile = resolveRegularFile(pythonRoot, target.file, "target lock");
  assertFileHash(lockFile, target.sha256, `Hy-Memory Python lock ${targetId}`);
  const requirements = parseHashedRequirements(fs.readFileSync(lockFile, "utf8"), lockFile);
  if (requirements.length !== target.distributionCount) {
    throw new CliError(
      `Hy-Memory Python lock ${targetId} distribution count is ${requirements.length}; expected ${target.distributionCount}`,
    );
  }
  requireLockedHash(requirements, HY_MEMORY_NAME, options.hyMemoryWheelSha256, lockFile);
  requireLockedHash(requirements, LANGDETECT_NAME, LANGDETECT_WHEEL_SHA256, lockFile);

  return Object.freeze({
    manifest,
    manifestFile,
    pythonRoot,
    target: Object.freeze({ ...target }),
    lockFile,
    lockSha256: target.sha256,
    lockId: `sha256:${target.sha256}`,
    requirements: Object.freeze(requirements.map((item) => Object.freeze({ ...item, hashes: Object.freeze([...item.hashes]) }))),
    vendorDir: path.join(pythonRoot, "vendor"),
    inspectorFile: path.join(pythonRoot, "inspect_runtime.py"),
  });
}

export function parseHashedRequirements(text, source = "requirements lock") {
  const requirements = [];
  let current = null;
  const seen = new Set();
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const requirement = rawLine.match(EXACT_REQUIREMENT_PATTERN);
    if (requirement && rawLine === rawLine.trimStart()) {
      const name = normalizeDistributionName(requirement[1]);
      const version = requirement[2];
      if (!name || !version || seen.has(name)) {
        throw new CliError(`${source}:${index + 1} contains a duplicate or invalid exact requirement`);
      }
      current = { name, version, hashes: [] };
      seen.add(name);
      requirements.push(current);
      continue;
    }
    const hashMatches = [...trimmed.matchAll(/--hash=sha256:([0-9a-f]{64})/g)];
    if (current && hashMatches.length > 0 && hashMatches.map((match) => match[0]).join(" ") === trimmed.replace(/\s*\\$/, "")) {
      current.hashes.push(...hashMatches.map((match) => match[1]));
      continue;
    }
    throw new CliError(`${source}:${index + 1} contains an unsupported requirement or directive`);
  }
  if (requirements.length === 0) throw new CliError(`${source} does not contain exact requirements`);
  for (const requirement of requirements) {
    if (requirement.hashes.length === 0) throw new CliError(`${source} requirement ${requirement.name} has no SHA-256 hash`);
    requirement.hashes = [...new Set(requirement.hashes)].sort();
  }
  return requirements;
}

export function sanitizedPythonInstallerEnvironment(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !INSTALLER_ENV_DENYLIST.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

export function uvSyncArguments(lock, python) {
  return [
    "--no-config",
    "pip",
    "sync",
    lock.lockFile,
    "--python",
    python,
    "--require-hashes",
    "--strict",
    "--only-binary",
    ":all:",
    "--find-links",
    lock.vendorDir,
    "--no-progress",
  ];
}

export function pipInstallArguments(lock) {
  return [
    "-m",
    "pip",
    "install",
    "--isolated",
    "--disable-pip-version-check",
    "--require-hashes",
    "--only-binary=:all:",
    "--no-deps",
    "--find-links",
    lock.vendorDir,
    "--requirement",
    lock.lockFile,
  ];
}

export function writePythonRuntimeManifest(options) {
  const args = [
    options.inspectorFile,
    "--output",
    options.outputFile,
    "--lock-id",
    options.lock.lockId,
    "--lock-target",
    options.lock.target.id,
    "--lock-sha256",
    options.lock.lockSha256,
    "--installer-kind",
    options.installer.kind,
    "--installer-version",
    options.installer.version,
    "--hy-memory-wheel-sha256",
    options.hyMemoryWheelSha256,
  ];
  const result = spawnSync(options.python, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs || 60_000,
    windowsHide: true,
    env: sanitizedPythonInstallerEnvironment(options.env),
  });
  if (result.error) throw new CliError(`failed to inspect Hy-Memory Python runtime: ${result.error.message}`);
  if (result.status !== 0) {
    throw new CliError(`Hy-Memory Python runtime inspection exited with ${result.status}: ${safeOutput(result.stderr || result.stdout)}`);
  }
  const manifest = validatePythonRuntimeManifest(options.outputFile, options.lock, options.hyMemoryWheelSha256);
  return { manifest, sha256: sha256File(options.outputFile) };
}

export function validatePythonRuntimeManifest(file, lock, hyMemoryWheelSha256) {
  const manifest = readJsonObject(file);
  if (
    manifest.schema !== HY_MEMORY_PYTHON_RUNTIME_SCHEMA ||
    manifest.lock?.id !== lock.lockId ||
    manifest.lock?.target !== lock.target.id ||
    manifest.lock?.sha256 !== lock.lockSha256 ||
    manifest.policy?.requireHashes !== true ||
    manifest.policy?.onlyBinary !== true ||
    typeof manifest.python?.version !== "string" ||
    !manifest.python.version.startsWith(`${HY_MEMORY_PYTHON_VERSION}.`) ||
    !["uv", "pip"].includes(manifest.installer?.kind) ||
    typeof manifest.installer?.version !== "string" ||
    !Array.isArray(manifest.distributions) ||
    manifest.distributionCount !== manifest.distributions.length ||
    !isSha256(manifest.closureSha256) ||
    manifest.hyMemory?.version !== lockedVersion(lock.requirements, HY_MEMORY_NAME) ||
    manifest.hyMemory?.wheelSha256 !== hyMemoryWheelSha256
  ) {
    throw new CliError(`Hy-Memory Python runtime manifest is invalid: ${file}`);
  }

  const installed = normalizeInstalledDistributions(manifest.distributions, file);
  if (closureSha256(installed) !== manifest.closureSha256) {
    throw new CliError(`Hy-Memory Python runtime manifest closure hash is invalid: ${file}`);
  }
  const expected = new Map(lock.requirements.map((item) => [item.name, item.version]));
  const actual = new Map(installed.map((item) => [item.name, item.version]));
  for (const [name, version] of expected) {
    if (actual.get(name) !== version) {
      throw new CliError(`Hy-Memory Python runtime closure is missing or drifted: ${name}==${version}`);
    }
  }
  const allowedExtras = manifest.installer.kind === "pip" ? PIP_BOOTSTRAP_DISTRIBUTIONS : new Set();
  for (const name of actual.keys()) {
    if (!expected.has(name) && !allowedExtras.has(name)) {
      throw new CliError(`Hy-Memory Python runtime closure contains an unexpected distribution: ${name}`);
    }
  }
  validateManifestPlatform(manifest, lock.target, file);
  return manifest;
}

export function validatePythonRuntimeManifestBinding(file, expected) {
  const manifest = readJsonObject(file);
  if (
    manifest.schema !== HY_MEMORY_PYTHON_RUNTIME_SCHEMA ||
    manifest.lock?.id !== expected.lockId ||
    manifest.lock?.target !== expected.lockTarget ||
    manifest.lock?.sha256 !== expected.lockSha256 ||
    manifest.policy?.requireHashes !== true ||
    manifest.policy?.onlyBinary !== true ||
    typeof manifest.python?.version !== "string" ||
    !manifest.python.version.startsWith(`${HY_MEMORY_PYTHON_VERSION}.`) ||
    !Array.isArray(manifest.distributions) ||
    manifest.distributionCount !== manifest.distributions.length ||
    manifest.hyMemory?.version !== expected.hyMemoryVersion ||
    manifest.hyMemory?.wheelSha256 !== expected.hyMemoryWheelSha256
  ) {
    throw new CliError(`Hy-Memory Python runtime manifest binding is invalid: ${file}`);
  }
  const installed = normalizeInstalledDistributions(manifest.distributions, file);
  if (closureSha256(installed) !== manifest.closureSha256) {
    throw new CliError(`Hy-Memory Python runtime manifest closure hash is invalid: ${file}`);
  }
  return manifest;
}

export function closureSha256(distributions) {
  const payload = distributions.map((item) => `${item.name}==${item.version}\n`).join("");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function validateLockManifestHeader(manifest, file) {
  if (
    manifest.schema !== HY_MEMORY_PYTHON_LOCK_SCHEMA ||
    manifest.python !== HY_MEMORY_PYTHON_VERSION ||
    manifest.resolver?.name !== "uv" ||
    typeof manifest.resolver?.version !== "string" ||
    typeof manifest.resolver?.excludeNewer !== "string" ||
    manifest.resolver?.requireHashes !== true ||
    manifest.resolver?.onlyBinary !== true ||
    typeof manifest.requirementsInput?.file !== "string" ||
    !isSha256(manifest.requirementsInput?.sha256) ||
    !Array.isArray(manifest.vendorArtifacts) ||
    !Array.isArray(manifest.targets)
  ) {
    throw new CliError(`Hy-Memory Python lock manifest is invalid: ${file}`);
  }
  const ids = manifest.targets.map((item) => item?.id);
  if (new Set(ids).size !== ids.length) throw new CliError(`Hy-Memory Python lock targets are duplicated in ${file}`);
}

function validateLockTarget(target, file) {
  if (
    typeof target.id !== "string" ||
    !["darwin", "linux", "win32"].includes(target.platform) ||
    typeof target.arch !== "string" ||
    ![null, "glibc"].includes(target.libc) ||
    typeof target.resolverTarget !== "string" ||
    typeof target.file !== "string" ||
    !isSha256(target.sha256) ||
    !Number.isInteger(target.distributionCount) ||
    target.distributionCount < 1 ||
    typeof target.qualified !== "boolean"
  ) throw new CliError(`Hy-Memory Python lock target is invalid in ${file}`);
}

function validateManifestPlatform(manifest, target, file) {
  const platformMatches = manifest.python.platform === target.platform;
  const machine = String(manifest.python.machine || "").toLowerCase();
  const archMatches = target.arch === "arm64"
    ? ["arm64", "aarch64"].includes(machine)
    : target.arch === "x64" && ["x86_64", "amd64"].includes(machine);
  if (!platformMatches || !archMatches) {
    throw new CliError(`Hy-Memory Python runtime platform does not match lock target ${target.id}: ${file}`);
  }
  if (target.libc === "glibc" && !String(manifest.python.libc?.[0] || "").toLowerCase().includes("glibc")) {
    throw new CliError(`Hy-Memory Python runtime libc does not match lock target ${target.id}: ${file}`);
  }
}

function normalizeInstalledDistributions(values, file) {
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const name = normalizeDistributionName(item?.name);
    const version = typeof item?.version === "string" ? item.version.trim() : "";
    if (!name || !version || seen.has(name)) throw new CliError(`Hy-Memory Python runtime distributions are invalid: ${file}`);
    seen.add(name);
    result.push({ name, version });
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

function requireLockedHash(requirements, name, expectedHash, file) {
  if (!isSha256(expectedHash)) throw new CliError(`expected wheel SHA-256 for ${name} is invalid`);
  const requirement = requirements.find((item) => item.name === name);
  if (!requirement || !requirement.hashes.includes(expectedHash)) {
    throw new CliError(`Hy-Memory Python lock ${file} does not bind the canonical ${name} wheel SHA-256`);
  }
}

function lockedVersion(requirements, name) {
  return requirements.find((item) => item.name === name)?.version;
}

function resolveRegularFile(root, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new CliError(`Hy-Memory Python ${label} path is invalid`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new CliError(`Hy-Memory Python ${label} escapes its managed root`);
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new CliError(`Hy-Memory Python ${label} is missing: ${resolved}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CliError(`Hy-Memory Python ${label} must be a regular non-symlink file: ${resolved}`);
  return resolved;
}

function assertFileHash(file, expected, label) {
  if (!isSha256(expected) || sha256File(file) !== expected) throw new CliError(`${label} SHA-256 does not match its manifest: ${file}`);
}

function readJsonObject(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`could not read ${file}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${file} must contain a JSON object`);
  return value;
}

function detectLinuxLibc() {
  try {
    return process.report?.getReport()?.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "unknown";
  }
}

function normalizeDistributionName(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[-_.]+/g, "-") : "";
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function safeOutput(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
