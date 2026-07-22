import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import { compareSemver } from "./npm-registry.mjs";
import { CliError } from "./output.mjs";
import { packageRoot } from "./paths.mjs";
import { captureCommand, runCommand } from "./shell-runner.mjs";
import { canonicalHashBytes } from "./skill-pack-integrity.mjs";

const BASELINES_SCHEMA = "pi67.managed-extension-baselines.v1";
const LEDGER_SCHEMA = "pi67.extension-ledger.v1";

export function readManagedExtensionBaselines(file = defaultBaselinesPath()) {
  const payload = readJsonFileIfExists(file);
  if (payload?.schema !== BASELINES_SCHEMA || !Array.isArray(payload.extensions)) {
    throw new CliError(`invalid managed extension baseline registry: ${file}`, 2);
  }
  const ids = new Set();
  for (const entry of payload.extensions) {
    validateBaselineEntry(entry, ids);
    ids.add(entry.id);
  }
  return payload;
}

export function inspectManagedExtensions(ctx, options = {}) {
  const registry = options.registry || readManagedExtensionBaselines();
  const sourceRoot = options.sourceRoot || ctx.repoRoot;
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const configuredSpecs = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
  const configuredIds = new Set(configuredSpecs.map(settingsSpecIdentity));
  const ledger = options.ledger || readExtensionLedger(ctx);
  const npmLock = readJsonFileIfExists(path.join(ctx.agentDir, "npm", "package-lock.json")) || {};
  const inspectedEntries = registry.extensions.map((baseline) => {
    const configured = configuredIds.has(settingsSpecIdentity(baseline.settingsSpec));
    const prior = ledger.extensions?.[baseline.id] || null;
    if (baseline.sourceKind === "npm") {
      return inspectNpmExtension(ctx, baseline, { configured, prior, npmLock, deepHash: options.deepHash });
    }
    if (baseline.sourceKind === "git") {
      return inspectGitExtension(ctx, baseline, { configured, prior });
    }
    return inspectBundledExtension(ctx, baseline, { prior, sourceRoot });
  });
  const entries = applyPiLoadProbe(inspectedEntries, options.loadProbe);
  const baselineIdentities = new Set(registry.extensions.map((entry) => settingsSpecIdentity(entry.settingsSpec)));
  const unknown = configuredSpecs
    .filter((spec) => !baselineIdentities.has(settingsSpecIdentity(spec)))
    .map((spec) => ({
      spec,
      identity: settingsSpecIdentity(spec),
      status: "unversioned-user-managed",
      action: "keep",
    }));
  return {
    schema: "pi67.managed-extensions-status.v1",
    createdAt: new Date().toISOString(),
    policy: registry.policy,
    ledger: {
      path: extensionLedgerPath(ctx),
      exists: fs.existsSync(extensionLedgerPath(ctx)),
      schema: ledger.schema || "",
    },
    loadProbe: options.loadProbe || null,
    summary: summarize(entries, unknown),
    extensions: entries,
    unknown,
  };
}

export function probePiExtensionLoads(ctx, options = {}) {
  const result = captureCommand("pi", ["list", "--no-approve"], {
    cwd: ctx.agentDir,
    timeoutMs: options.timeoutMs || 60_000,
  });
  const parsed = parsePiListOutput(result.stdout);
  return {
    schema: "pi67.pi-extension-load-probe.v1",
    attempted: true,
    ok: result.ok && parsed.recognized,
    commandAvailable: !(result.error || "").toLowerCase().includes("enoent"),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    error: result.error || (!result.ok ? compactProbeFailure(result.stderr) : ""),
    recognized: parsed.recognized,
    loadedSpecs: parsed.loadedSpecs,
    warnings: parsed.warnings,
  };
}

export function parsePiListOutput(output) {
  const loadedSpecs = [];
  const warnings = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const specMatch = rawLine.match(/^\s{2}((?:npm|git):\S+)\s*$/);
    if (specMatch) loadedSpecs.push(settingsSpecIdentity(specMatch[1]));
    if (/warning|error|duplicate|conflict|skipped/i.test(rawLine)) warnings.push(rawLine.trim());
  }
  return {
    recognized: /(^|\r?\n)User packages:\s*(\r?\n|$)/.test(String(output || "")),
    loadedSpecs: [...new Set(loadedSpecs)],
    warnings,
  };
}

export function classifyNpmExtension({ installedVersion, minimumVersion, configured, managedPristine }) {
  if (!installedVersion || !configured) {
    return { status: "missing", action: installedVersion ? "configure" : "install" };
  }
  const comparison = compareSemver(installedVersion, minimumVersion);
  if (comparison > 0) return { status: "user-managed-ahead", action: "keep" };
  if (comparison === 0) {
    return managedPristine
      ? { status: "at-baseline", action: "keep" }
      : { status: "user-managed-diverged", action: "keep-conflict" };
  }
  return managedPristine
    ? { status: "below-baseline", action: "upgrade" }
    : { status: "user-managed-diverged", action: "keep-conflict" };
}

export function readExtensionLedger(ctx) {
  const payload = readJsonFileIfExists(extensionLedgerPath(ctx));
  if (!payload) return { schema: LEDGER_SCHEMA, extensions: {} };
  if (payload.schema !== LEDGER_SCHEMA || !payload.extensions || typeof payload.extensions !== "object") {
    throw new CliError(`invalid extension ledger: ${extensionLedgerPath(ctx)}`, 2);
  }
  return payload;
}

export function writeExtensionLedger(ctx, status, options = {}) {
  const previous = readExtensionLedger(ctx);
  const managedIds = new Set(options.managedIds || []);
  const extensions = { ...previous.extensions };
  for (const entry of status.extensions) {
    const prior = extensions[entry.id] || {};
    const managedNow = managedIds.has(entry.id) || entry.status === "at-baseline";
    extensions[entry.id] = {
      id: entry.id,
      sourceKind: entry.sourceKind,
      settingsSpec: entry.settingsSpec,
      releaseBaselineVersion: entry.minimumVersion || "",
      releaseBaselineCommit: entry.minimumCommit || "",
      lastManagedVersion: managedNow && entry.installedVersion
        ? entry.installedVersion
        : prior.lastManagedVersion || "",
      lastManagedCommit: managedNow && entry.installedCommit
        ? entry.installedCommit
        : prior.lastManagedCommit || "",
      lastManagedHash: managedNow && entry.contentHash
        ? entry.contentHash
        : prior.lastManagedHash || "",
      observedVersion: entry.installedVersion || "",
      observedCommit: entry.installedCommit || "",
      observedHash: entry.contentHash || "",
      observedSource: entry.observedSource || "",
      status: entry.status,
      updatedAt: new Date().toISOString(),
    };
  }
  const payload = {
    schema: LEDGER_SCHEMA,
    updatedAt: new Date().toISOString(),
    extensions,
  };
  writeJsonAtomic(extensionLedgerPath(ctx), payload);
  return payload;
}

export function applyManagedExtensionBaselines(ctx, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const skipNpm = Boolean(options.skipNpm);
  const inspectOptions = {
    deepHash: true,
    registry: options.registry,
    sourceRoot: options.sourceRoot,
  };
  const before = inspectManagedExtensions(ctx, inspectOptions);
  const actionable = before.extensions.filter((entry) => ["install", "upgrade", "configure"].includes(entry.action));
  const applied = [];
  const skipped = [];
  for (const entry of actionable) {
    if (entry.sourceKind === "npm" && skipNpm && entry.action !== "configure") {
      skipped.push({ id: entry.id, reason: "npm changes skipped by --no-npm" });
      continue;
    }
    if (entry.action === "configure") {
      applied.push({ id: entry.id, action: dryRun ? "configure-dry-run" : "configure" });
      continue;
    }
    if (dryRun) {
      applied.push({ id: entry.id, action: `${entry.action}-dry-run` });
      continue;
    }
    if (entry.sourceKind === "npm") installNpmBaseline(ctx, entry, { sourceRoot: options.sourceRoot });
    else if (entry.sourceKind === "git") installGitBaseline(ctx, entry);
    else installBundledBaseline(ctx, entry, { sourceRoot: options.sourceRoot });
    applied.push({ id: entry.id, action: entry.action });
  }

  const settingsResult = ensureDefaultSettingsPackages(ctx, before.extensions, { dryRun });
  if (dryRun) {
    return {
      schema: "pi67.managed-extensions-apply.v1",
      dryRun: true,
      before,
      applied,
      skipped,
      settings: settingsResult,
    };
  }

  const after = inspectManagedExtensions(ctx, inspectOptions);
  const managedIds = applied.map((entry) => entry.id);
  const ledger = writeExtensionLedger(ctx, after, { managedIds });
  return {
    schema: "pi67.managed-extensions-apply.v1",
    dryRun: false,
    before,
    after,
    applied,
    skipped,
    settings: settingsResult,
    ledger,
  };
}

export function restoreManagedExtension(ctx, id, options = {}) {
  const inspectOptions = {
    deepHash: true,
    registry: options.registry,
    sourceRoot: options.sourceRoot,
  };
  const status = inspectManagedExtensions(ctx, inspectOptions);
  const entry = status.extensions.find((item) => item.id === id);
  if (!entry) throw new CliError(`unknown managed extension: ${id}`, 2);
  const dryRun = Boolean(options.dryRun);
  if (dryRun) {
    return {
      schema: "pi67.managed-extension-restore.v1",
      dryRun: true,
      extension: entry,
      action: "backup-and-restore-baseline",
    };
  }
  const backupDir = backupExtension(ctx, entry);
  if (entry.sourceKind === "npm") {
    installNpmBaseline(ctx, entry, { force: true, sourceRoot: options.sourceRoot });
  } else if (entry.sourceKind === "git") {
    installGitBaseline(ctx, entry, { force: true });
  } else {
    installBundledBaseline(ctx, entry, { force: true, sourceRoot: options.sourceRoot });
  }
  ensureDefaultSettingsPackages(ctx, [entry]);
  const after = inspectManagedExtensions(ctx, inspectOptions);
  writeExtensionLedger(ctx, after, { managedIds: [entry.id] });
  return {
    schema: "pi67.managed-extension-restore.v1",
    dryRun: false,
    backupDir,
    before: entry,
    after: after.extensions.find((item) => item.id === id),
  };
}

export function diffManagedExtension(ctx, id, options = {}) {
  const status = inspectManagedExtensions(ctx, {
    deepHash: true,
    registry: options.registry,
    sourceRoot: options.sourceRoot,
  });
  const entry = status.extensions.find((item) => item.id === id);
  if (!entry) throw new CliError(`unknown managed extension: ${id}`, 2);
  return {
    schema: "pi67.managed-extension-diff.v1",
    createdAt: new Date().toISOString(),
    extension: entry,
    differsFromBaseline: !["at-baseline", "missing"].includes(entry.status),
    safeAutomaticAction: ["install", "upgrade", "configure"].includes(entry.action),
  };
}

function inspectNpmExtension(ctx, baseline, options) {
  const installPath = path.join(ctx.agentDir, "npm", "node_modules", ...baseline.packageName.split("/"));
  const packageJsonPath = path.join(installPath, "package.json");
  const pkg = readJsonFileIfExists(packageJsonPath) || {};
  const installedVersion = typeof pkg.version === "string" ? pkg.version : "";
  const lockEntry = options.npmLock?.packages?.[`node_modules/${baseline.packageName}`] || {};
  const lockMatchesInstalled = Boolean(installedVersion) && lockEntry.version === installedVersion;
  const shouldHash = Boolean(options.deepHash || options.prior?.lastManagedHash || baseline.contentHash);
  const contentHash = shouldHash && fs.existsSync(installPath) ? hashPackageTree(installPath) : "";
  const priorMatches = Boolean(
    options.prior?.lastManagedVersion === installedVersion
      && options.prior?.lastManagedHash
      && options.prior.lastManagedHash === contentHash,
  );
  const baselineHashMatches = Boolean(
    installedVersion === baseline.minimumVersion
      && baseline.contentHash
      && baseline.contentHash === contentHash,
  );
  const managedPristine = !installedVersion || priorMatches || baselineHashMatches;
  const classification = classifyNpmExtension({
    installedVersion,
    minimumVersion: baseline.minimumVersion,
    configured: options.configured,
    managedPristine,
  });
  return {
    ...baseline,
    configured: options.configured,
    installPath,
    installedVersion,
    installedCommit: "",
    contentHash,
    observedSource: lockEntry.resolved || baseline.settingsSpec,
    lockMatchesInstalled,
    managedPristine,
    ...classification,
  };
}

function inspectBundledExtension(ctx, baseline, options) {
  const installPath = path.join(ctx.agentDir, baseline.bundlePath);
  const sourcePath = path.join(options.sourceRoot, baseline.bundlePath);
  if (!fs.existsSync(sourcePath)) {
    throw new CliError(`bundled extension baseline is missing: ${sourcePath}`, 2);
  }
  const baselineHash = hashPackageTree(sourcePath);
  if (baseline.contentHash && baseline.contentHash !== baselineHash) {
    throw new CliError(`bundled extension baseline hash mismatch: ${baseline.id}`, 2);
  }
  if (!fs.existsSync(installPath)) {
    return {
      ...baseline,
      configured: true,
      installPath,
      installedVersion: "",
      installedCommit: "",
      contentHash: "",
      baselineHash,
      observedSource: sourcePath,
      managedPristine: true,
      status: "missing",
      action: "install",
    };
  }
  const contentHash = hashPackageTree(installPath);
  const priorMatches = Boolean(
    options.prior?.lastManagedHash && options.prior.lastManagedHash === contentHash,
  );
  const atBaseline = contentHash === baselineHash;
  const installedVersion = atBaseline ? baseline.minimumVersion : options.prior?.lastManagedVersion || "";
  const managedComparison = priorMatches && installedVersion
    ? compareSemver(installedVersion, baseline.minimumVersion)
    : null;
  let status = "user-managed-diverged";
  let action = "keep-conflict";
  if (atBaseline) {
    status = "at-baseline";
    action = "keep";
  } else if (managedComparison > 0) {
    status = "user-managed-ahead";
    action = "keep";
  } else if (managedComparison < 0) {
    status = "below-baseline";
    action = "upgrade";
  }
  return {
    ...baseline,
    configured: true,
    installPath,
    installedVersion,
    installedCommit: "",
    contentHash,
    baselineHash,
    observedSource: sourcePath,
    managedPristine: atBaseline || priorMatches,
    status,
    action,
  };
}

function inspectGitExtension(ctx, baseline, options) {
  const installPath = path.join(ctx.agentDir, baseline.checkoutPath);
  if (!fs.existsSync(installPath) || !fs.existsSync(path.join(installPath, ".git"))) {
    return {
      ...baseline,
      configured: options.configured,
      installPath,
      installedVersion: "",
      installedCommit: "",
      contentHash: "",
      observedSource: "",
      managedPristine: true,
      status: "missing",
      action: "install",
    };
  }
  const head = captureCommand("git", ["rev-parse", "HEAD"], { cwd: installPath });
  const origin = captureCommand("git", ["remote", "get-url", "origin"], { cwd: installPath });
  const dirty = captureCommand("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: installPath });
  const installedCommit = head.ok ? head.stdout.trim() : "";
  const observedSource = origin.ok ? origin.stdout.trim() : "";
  const trackedDirty = dirty.ok ? Boolean(dirty.stdout.trim()) : true;
  const sourceMatches = normalizeGitUrl(observedSource) === normalizeGitUrl(baseline.repoUrl);
  let status = "user-managed-diverged";
  let action = "keep-conflict";
  if (!options.configured) {
    status = "missing";
    action = "configure";
  } else if (sourceMatches && !trackedDirty && installedCommit === baseline.minimumCommit) {
    status = "at-baseline";
    action = "keep";
  } else if (sourceMatches && !trackedDirty && isAncestor(installPath, baseline.minimumCommit, installedCommit)) {
    status = "user-managed-ahead";
    action = "keep";
  } else if (sourceMatches && !trackedDirty && isAncestor(installPath, installedCommit, baseline.minimumCommit)) {
    status = "below-baseline";
    action = "upgrade";
  }
  return {
    ...baseline,
    configured: options.configured,
    installPath,
    installedVersion: "",
    installedCommit,
    contentHash: installedCommit,
    observedSource,
    trackedDirty,
    sourceMatches,
    managedPristine: sourceMatches && !trackedDirty,
    status,
    action,
  };
}

function installNpmBaseline(ctx, entry, options = {}) {
  const npmDir = path.join(ctx.agentDir, "npm");
  fs.mkdirSync(npmDir, { recursive: true });
  const packageFile = path.join(npmDir, "package.json");
  if (!fs.existsSync(packageFile)) {
    writeJsonAtomic(packageFile, { name: "pi-67-runtime-extensions", private: true, dependencies: {} });
  }
  runCommand("npm", [
    "install",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `${entry.packageName}@${entry.minimumVersion}`,
  ], { cwd: npmDir });
  applyCompatibilityPatch(ctx, entry, options.sourceRoot || ctx.repoRoot);
}

function installGitBaseline(ctx, entry, options = {}) {
  const installPath = entry.installPath || path.join(ctx.agentDir, entry.checkoutPath);
  const created = !fs.existsSync(path.join(installPath, ".git"));
  if (created) {
    fs.mkdirSync(path.dirname(installPath), { recursive: true });
    runCommand("git", ["clone", entry.repoUrl, installPath]);
  }
  runCommand("git", ["fetch", "origin", entry.minimumCommit], { cwd: installPath });
  if (options.force || created) {
    runCommand("git", ["checkout", "--detach", entry.minimumCommit], { cwd: installPath });
  } else {
    runCommand("git", ["merge", "--ff-only", entry.minimumCommit], { cwd: installPath });
  }
  if (fs.existsSync(path.join(installPath, "package.json"))) {
    runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installPath });
  }
}

function installBundledBaseline(ctx, entry, options = {}) {
  const sourceRoot = options.sourceRoot || ctx.repoRoot;
  const sourcePath = path.join(sourceRoot, entry.bundlePath);
  const installPath = entry.installPath || path.join(ctx.agentDir, entry.bundlePath);
  if (!fs.existsSync(sourcePath)) {
    throw new CliError(`bundled extension baseline is missing: ${sourcePath}`, 2);
  }
  if (path.resolve(sourcePath) === path.resolve(installPath)) return;
  const parent = path.dirname(installPath);
  const transactionRoot = path.join(parent, `.pi67-extension-${safeName(entry.id)}-${process.pid}`);
  const staged = path.join(transactionRoot, "staged");
  const previous = path.join(transactionRoot, "previous");
  fs.mkdirSync(transactionRoot, { recursive: true });
  try {
    fs.cpSync(sourcePath, staged, { recursive: true, errorOnExist: true });
    if (fs.existsSync(installPath)) fs.renameSync(installPath, previous);
    fs.renameSync(staged, installPath);
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(installPath) && fs.existsSync(previous)) fs.renameSync(previous, installPath);
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

function applyCompatibilityPatch(ctx, entry, sourceRoot) {
  const patchers = {
    "pi-until-done": "pi67-patch-pi-until-done-runtime-queue.mjs",
    "pi-smart-fetch": "pi67-patch-pi-smart-fetch-charset.mjs",
  };
  const patcher = patchers[entry.id];
  if (!patcher) return;
  const file = path.join(sourceRoot, "scripts", patcher);
  if (!fs.existsSync(file)) throw new CliError(`managed extension compatibility patcher is missing: ${file}`, 2);
  runCommand(process.execPath, [file, "--apply", "--agent-dir", ctx.agentDir]);
}

function ensureDefaultSettingsPackages(ctx, entries, options = {}) {
  const settingsPath = path.join(ctx.agentDir, "settings.json");
  const settings = readJsonFileIfExists(settingsPath) || {};
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const identities = new Set(packages.map(settingsSpecIdentity));
  const added = [];
  for (const entry of entries) {
    if (!entry.settingsSpec) continue;
    const identity = settingsSpecIdentity(entry.settingsSpec);
    if (identities.has(identity)) continue;
    packages.push(entry.settingsSpec);
    identities.add(identity);
    added.push(entry.settingsSpec);
  }
  if (added.length > 0 && !options.dryRun) {
    writeJsonAtomic(settingsPath, { ...settings, packages });
  }
  return { changed: added.length > 0, added };
}

function backupExtension(ctx, entry) {
  const backupDir = path.join(
    ctx.stateDir,
    "backups",
    `${timestamp()}-extension-restore-${safeName(entry.id)}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(entry.installPath)) {
    fs.cpSync(entry.installPath, path.join(backupDir, "package"), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("node_modules"),
    });
  }
  const settingsPath = path.join(ctx.agentDir, "settings.json");
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, path.join(backupDir, "settings.json"));
  writeJsonAtomic(path.join(backupDir, "manifest.json"), {
    schema: "pi67.extension-restore-backup.v1",
    createdAt: new Date().toISOString(),
    extension: entry,
  });
  return backupDir;
}

function hashPackageTree(root) {
  const files = [];
  walkPackage(root, root, files);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(canonicalHashBytes(fs.readFileSync(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkPackage(root, dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "__pycache__"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPackage(root, full, files);
    else if (entry.isFile() && !entry.name.endsWith(".map") && !entry.name.endsWith(".pyc")) files.push(full);
  }
}

function isAncestor(repo, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  return captureCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo }).ok;
}

function applyPiLoadProbe(entries, probe) {
  if (!probe?.ok || !probe.recognized) return entries;
  const loaded = new Set((probe.loadedSpecs || []).map(settingsSpecIdentity));
  return entries.map((entry) => {
    if (!entry.settingsSpec) return { ...entry, loadStatus: "not-applicable" };
    if (!entry.configured || entry.status === "missing") return { ...entry, loadStatus: "not-configured" };
    if (loaded.has(settingsSpecIdentity(entry.settingsSpec))) return { ...entry, loadStatus: "loaded" };
    return {
      ...entry,
      baselineStatus: entry.status,
      status: "load-failed",
      action: "keep-conflict",
      loadStatus: "not-listed",
      loadFailure: "configured package was not resolved by pi list --no-approve",
    };
  });
}

function compactProbeFailure(stderr) {
  return String(stderr || "")
    .trim()
    .split(/\r?\n/)
    .slice(0, 3)
    .join(" | ")
    .slice(0, 500);
}

function summarize(entries, unknown) {
  const summary = {
    total: entries.length,
    missing: 0,
    belowBaseline: 0,
    atBaseline: 0,
    userManagedAhead: 0,
    userManagedDiverged: 0,
    loadFailed: 0,
    unknown: unknown.length,
    automaticActions: 0,
  };
  for (const entry of entries) {
    if (entry.status === "missing") summary.missing += 1;
    else if (entry.status === "below-baseline") summary.belowBaseline += 1;
    else if (entry.status === "at-baseline") summary.atBaseline += 1;
    else if (entry.status === "user-managed-ahead") summary.userManagedAhead += 1;
    else if (entry.status === "user-managed-diverged") summary.userManagedDiverged += 1;
    else if (entry.status === "load-failed") summary.loadFailed += 1;
    if (["install", "upgrade", "configure"].includes(entry.action)) summary.automaticActions += 1;
  }
  return summary;
}

function settingsSpecIdentity(spec) {
  const value = String(spec || "").trim();
  if (value.startsWith("npm:")) {
    const raw = value.slice(4);
    if (raw.startsWith("@")) {
      const slash = raw.indexOf("/");
      const versionAt = slash === -1 ? -1 : raw.indexOf("@", slash + 1);
      return `npm:${versionAt === -1 ? raw : raw.slice(0, versionAt)}`;
    }
    const versionAt = raw.indexOf("@");
    return `npm:${versionAt === -1 ? raw : raw.slice(0, versionAt)}`;
  }
  if (value.startsWith("git:")) return `git:${normalizeGitUrl(value.slice(4).replace(/@[^/]+$/, ""))}`;
  return value;
}

function normalizeGitUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^git:/, "")
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function validateBaselineEntry(entry, ids) {
  if (!entry?.id || ids.has(entry.id)) throw new CliError(`duplicate or missing extension baseline id: ${entry?.id || "unknown"}`, 2);
  if (!["npm", "git", "bundled"].includes(entry.sourceKind)) throw new CliError(`unsupported extension sourceKind for ${entry.id}`, 2);
  if (entry.sourceKind !== "bundled" && (!entry.settingsSpec || !entry.packageName)) {
    throw new CliError(`extension baseline ${entry.id} requires settingsSpec and packageName`, 2);
  }
  if (entry.sourceKind === "npm" && !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(entry.minimumVersion || "")) {
    throw new CliError(`npm extension baseline ${entry.id} requires minimumVersion`, 2);
  }
  if (entry.sourceKind === "git" && !/^[0-9a-f]{40}$/.test(entry.minimumCommit || "")) {
    throw new CliError(`git extension baseline ${entry.id} requires a 40-character minimumCommit`, 2);
  }
  if (entry.sourceKind === "bundled" && (!entry.bundlePath || !entry.minimumVersion || !entry.contentHash)) {
    throw new CliError(`bundled extension baseline ${entry.id} requires bundlePath, minimumVersion, and contentHash`, 2);
  }
}

function defaultBaselinesPath() {
  return path.join(packageRoot(), "src", "data", "managed-extension-baselines.json");
}

function extensionLedgerPath(ctx) {
  return path.join(ctx.stateDir, "extension-ledger.json");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function safeName(value) {
  return String(value || "extension").replace(/[^A-Za-z0-9._-]+/g, "-");
}
