import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import { compareSemver } from "./npm-registry.mjs";
import { CliError } from "./output.mjs";
import { packageRoot } from "./paths.mjs";
import { captureCommand, runCommand } from "./shell-runner.mjs";
import { canonicalHashBytes } from "./skill-pack-integrity.mjs";

const BASELINES_SCHEMA = "pi67.managed-extension-baselines.v2";
const LEDGER_SCHEMA = "pi67.extension-ledger.v1";
const PI_CODING_AGENT_PACKAGES = new Set([
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
]);

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
  collectExactNpmSpecs(payload.extensions.filter((entry) => entry.sourceKind === "npm"));
  return payload;
}

export function inspectManagedExtensions(ctx, options = {}) {
  const registry = options.registry || readManagedExtensionBaselines();
  const sourceRoot = options.sourceRoot || ctx.repoRoot;
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const configuredPackages = (Array.isArray(settings.packages) ? settings.packages : [])
    .map((entry, settingsIndex) => ({ settingsIndex, source: settingsPackageSource(entry) }));
  const configuredIds = new Set(configuredPackages.map((item) => settingsSpecIdentity(item.source)).filter(Boolean));
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
  const baselineIdentities = new Set(
    registry.extensions.map((entry) => settingsSpecIdentity(entry.settingsSpec)).filter(Boolean),
  );
  const unknown = configuredPackages
    .filter((item) => !item.source || !baselineIdentities.has(settingsSpecIdentity(item.source)))
    .map((item) => item.source
      ? {
          spec: item.source,
          identity: settingsSpecIdentity(item.source),
          settingsIndex: item.settingsIndex,
          status: "unversioned-user-managed",
          action: "keep",
        }
      : {
          spec: `settings.packages[${item.settingsIndex}]`,
          identity: `invalid-settings-package:${item.settingsIndex}`,
          settingsIndex: item.settingsIndex,
          status: "invalid-settings-package-entry",
          action: "keep-conflict",
        });
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
    filteredSpecs: parsed.filteredSpecs,
    warnings: parsed.warnings,
  };
}

export function parsePiListOutput(output) {
  const loadedSpecs = [];
  const filteredSpecs = [];
  const warnings = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const specMatch = rawLine.match(/^\s{2}((?:npm|git):\S+)(?:\s+\((filtered)\))?\s*$/);
    if (specMatch) {
      const target = specMatch[2] ? filteredSpecs : loadedSpecs;
      target.push(settingsSpecIdentity(specMatch[1]));
    }
    if (/warning|error|duplicate|conflict|skipped/i.test(rawLine)) warnings.push(rawLine.trim());
  }
  return {
    recognized: /(^|\r?\n)User packages:\s*(\r?\n|$)/.test(String(output || "")),
    loadedSpecs: [...new Set(loadedSpecs)],
    filteredSpecs: [...new Set(filteredSpecs)],
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
    const entryRevision = positiveIntegerOrNull(entry.contentRevision);
    const lastManagedRevision = managedNow && entryRevision !== null
      ? entryRevision
      : prior.lastManagedRevision;
    extensions[entry.id] = {
      id: entry.id,
      sourceKind: entry.sourceKind,
      settingsSpec: entry.settingsSpec,
      releaseBaselineVersion: entry.minimumVersion || "",
      releaseBaselineCommit: entry.minimumCommit || "",
      ...(entryRevision !== null
        ? { releaseBaselineRevision: entryRevision }
        : {}),
      lastManagedVersion: managedNow && entry.installedVersion
        ? entry.installedVersion
        : prior.lastManagedVersion || "",
      lastManagedCommit: managedNow && entry.installedCommit
        ? entry.installedCommit
        : prior.lastManagedCommit || "",
      lastManagedHash: managedNow && entry.contentHash
        ? entry.contentHash
        : prior.lastManagedHash || "",
      ...(Number.isInteger(lastManagedRevision) ? { lastManagedRevision } : {}),
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
  const inspect = options.inspect || inspectManagedExtensions;
  const before = inspect(ctx, inspectOptions);
  const previousLedger = readExtensionLedger(ctx);
  const ledgerRefreshIds = before.extensions
    .filter((entry) => needsBundledLedgerRefresh(entry, previousLedger.extensions?.[entry.id]))
    .map((entry) => entry.id);
  const actionable = before.extensions.filter((entry) => ["install", "upgrade", "configure"].includes(entry.action));
  const applied = [];
  const skipped = [];
  const npmEntries = [];
  const otherEntries = [];
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
    if (entry.sourceKind === "npm") npmEntries.push(entry);
    else otherEntries.push(entry);
    applied.push({ id: entry.id, action: entry.action });
  }

  if (!dryRun && npmEntries.length > 0) {
    installNpmBaselines(ctx, npmEntries, {
      commandRunner: options.commandRunner,
      commandStdio: options.commandStdio,
      sourceRoot: options.sourceRoot,
    });
  }
  if (!dryRun) {
    for (const entry of otherEntries) {
      if (entry.sourceKind === "git") {
        installGitBaseline(ctx, entry, {
          commandRunner: options.commandRunner,
          commandStdio: options.commandStdio,
        });
      } else installBundledBaseline(ctx, entry, { sourceRoot: options.sourceRoot });
    }
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

  if (applied.length === 0 && !settingsResult.changed) {
    const ledger = ledgerRefreshIds.length > 0
      ? writeExtensionLedger(ctx, before, { managedIds: ledgerRefreshIds })
      : previousLedger;
    return {
      schema: "pi67.managed-extensions-apply.v1",
      dryRun: false,
      before,
      after: before,
      applied,
      skipped,
      settings: settingsResult,
      ledger,
    };
  }

  const after = inspect(ctx, inspectOptions);
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
    installNpmBaselines(ctx, [entry], {
      commandRunner: options.commandRunner,
      commandStdio: options.commandStdio,
      sourceRoot: options.sourceRoot,
    });
  } else if (entry.sourceKind === "git") {
    installGitBaseline(ctx, entry, {
      force: true,
      commandRunner: options.commandRunner,
      commandStdio: options.commandStdio,
    });
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
  const runtimeDependencyClosure = inspectNpmRuntimeDependencies(ctx, baseline, options.npmLock);
  let classification = classifyNpmExtension({
    installedVersion,
    minimumVersion: baseline.minimumVersion,
    configured: options.configured,
    managedPristine,
  });
  if (
    installedVersion === baseline.minimumVersion
      && !runtimeDependencyClosure.ready
      && classification.status !== "user-managed-diverged"
      && classification.status !== "user-managed-ahead"
  ) {
    classification = { status: "below-baseline", action: "upgrade" };
  }
  return {
    ...baseline,
    configured: options.configured,
    installPath,
    installedVersion,
    installedCommit: "",
    contentHash,
    observedSource: lockEntry.resolved || baseline.settingsSpec,
    lockMatchesInstalled,
    runtimeDependencyClosure,
    managedPristine,
    ...classification,
  };
}

function inspectNpmRuntimeDependencies(ctx, baseline, npmLock) {
  const dependencies = Object.entries(baseline.runtimeDependencies || {}).map(([packageName, expectedVersion]) => {
    const installPath = path.join(ctx.agentDir, "npm", "node_modules", ...packageName.split("/"));
    const installed = readJsonFileIfExists(path.join(installPath, "package.json")) || {};
    const installedVersion = typeof installed.version === "string" ? installed.version : "";
    const lockEntry = npmLock?.packages?.[`node_modules/${packageName}`] || {};
    return {
      packageName,
      expectedVersion,
      installedVersion,
      installPath,
      lockMatchesInstalled: Boolean(installedVersion) && lockEntry.version === installedVersion,
      ready: installedVersion === expectedVersion && lockEntry.version === expectedVersion,
    };
  });
  return {
    ready: dependencies.every((entry) => entry.ready),
    dependencies,
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
  const installedContentRevision = atBaseline
    ? baseline.contentRevision
    : positiveIntegerOrNull(options.prior?.lastManagedRevision);
  const revisionComparison = managedComparison === 0 && installedContentRevision !== null
    ? installedContentRevision - baseline.contentRevision
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
  } else if (revisionComparison > 0) {
    status = "user-managed-ahead";
    action = "keep";
  } else if (revisionComparison < 0) {
    status = "below-baseline";
    action = "upgrade";
  }
  return {
    ...baseline,
    configured: true,
    installPath,
    installedVersion,
    installedContentRevision,
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

function installNpmBaselines(ctx, entries, options = {}) {
  const plan = planNpmBaselineInstall(ctx, entries);
  const npmDir = path.join(ctx.agentDir, "npm");
  assertNoPhysicalPiCodingAgentPackages(npmDir, "before managed extension installation");
  fs.mkdirSync(npmDir, { recursive: true });
  const packageFile = path.join(npmDir, "package.json");
  if (!fs.existsSync(packageFile)) {
    writeJsonAtomic(packageFile, { name: "pi-67-runtime-extensions", private: true, dependencies: {} });
  }
  const commandRunner = options.commandRunner || runCommand;
  try {
    commandRunner(plan.command, plan.args, commandRunOptions(options, plan.cwd));
  } catch (error) {
    cleanupIntroducedPiCodingAgentPackages(npmDir, error);
    throw error;
  }
  const parallelRuntimes = findPhysicalPiCodingAgentPackages(npmDir);
  if (parallelRuntimes.length > 0) {
    cleanupIntroducedPiCodingAgentPackages(npmDir);
    throw new CliError(
      `managed extension install introduced and removed a parallel Pi runtime: ${parallelRuntimes.join(", ")}`,
      1,
    );
  }
  for (const entry of entries) {
    applyCompatibilityPatch(
      ctx,
      entry,
      options.sourceRoot || ctx.repoRoot,
      commandRunner,
      options.commandStdio,
    );
  }
}

export function planNpmBaselineInstall(ctx, entries) {
  const specs = collectExactNpmSpecs(entries);
  return {
    schema: "pi67.managed-extension-npm-install-plan.v1",
    command: "npm",
    args: [
      "install",
      "--save-exact",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...specs.map((entry) => `${entry.packageName}@${entry.version}`),
    ],
    cwd: path.join(ctx.agentDir, "npm"),
    extensionIds: entries.map((entry) => entry.id),
    specs,
  };
}

export function findPhysicalPiCodingAgentPackages(npmDir) {
  const found = [];
  const root = path.join(npmDir, "node_modules");
  visitNodeModules(root, found);
  return found.sort();
}

function collectExactNpmSpecs(entries) {
  const versions = new Map();
  for (const entry of entries) {
    if (entry.sourceKind !== "npm") {
      throw new CliError(`non-npm extension cannot enter an npm install batch: ${entry.id || "unknown"}`, 2);
    }
    addExactNpmSpec(versions, entry.packageName, entry.minimumVersion, entry.id);
  }
  for (const entry of entries) {
    for (const [packageName, version] of Object.entries(entry.runtimeDependencies || {})) {
      addExactNpmSpec(versions, packageName, version, entry.id);
    }
  }
  return [...versions.entries()].map(([packageName, value]) => ({
    packageName,
    version: value.version,
    owner: value.owner,
  }));
}

function addExactNpmSpec(versions, packageName, version, owner) {
  if (PI_CODING_AGENT_PACKAGES.has(packageName)) {
    throw new CliError(
      `managed extensions must use the host Pi runtime instead of installing ${packageName} (${owner})`,
      2,
    );
  }
  const prior = versions.get(packageName);
  if (prior && prior.version !== version) {
    throw new CliError(
      `managed extensions require conflicting versions of ${packageName}: ${prior.version} (${prior.owner}) and ${version} (${owner})`,
      2,
    );
  }
  if (!prior) versions.set(packageName, { version, owner });
}

function visitNodeModules(nodeModulesDir, found) {
  if (!fs.existsSync(nodeModulesDir)) return;
  for (const packageName of PI_CODING_AGENT_PACKAGES) {
    const candidate = path.join(nodeModulesDir, ...packageName.split("/"));
    if (fs.existsSync(candidate) && !fs.lstatSync(candidate).isSymbolicLink()) found.push(candidate);
  }
  for (const packageRoot of installedPackageRoots(nodeModulesDir)) {
    visitNodeModules(path.join(packageRoot, "node_modules"), found);
  }
}

function installedPackageRoots(nodeModulesDir) {
  const roots = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const candidate = path.join(nodeModulesDir, entry.name);
    if (!entry.name.startsWith("@")) {
      roots.push(candidate);
      continue;
    }
    for (const scoped of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (scoped.isDirectory() && !scoped.isSymbolicLink()) roots.push(path.join(candidate, scoped.name));
    }
  }
  return roots;
}

function installGitBaseline(ctx, entry, options = {}) {
  const installPath = entry.installPath || path.join(ctx.agentDir, entry.checkoutPath);
  const commandRunner = options.commandRunner || runCommand;
  assertNoPhysicalPiCodingAgentPackages(installPath, `before mutating managed Git extension ${entry.id}`);
  const created = !fs.existsSync(path.join(installPath, ".git"));
  if (created) {
    fs.mkdirSync(path.dirname(installPath), { recursive: true });
    commandRunner("git", ["clone", entry.repoUrl, installPath], commandRunOptions(options));
  }
  commandRunner("git", ["fetch", "origin", entry.minimumCommit], commandRunOptions(options, installPath));
  if (options.force || created) {
    commandRunner("git", ["checkout", "--detach", entry.minimumCommit], commandRunOptions(options, installPath));
  } else {
    commandRunner("git", ["merge", "--ff-only", entry.minimumCommit], commandRunOptions(options, installPath));
  }
  if (fs.existsSync(path.join(installPath, "package.json"))) {
    assertNoPhysicalPiCodingAgentPackages(installPath, `before installing managed Git extension ${entry.id}`);
    try {
      commandRunner(
        "npm",
        ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"],
        commandRunOptions(options, installPath),
      );
    } catch (error) {
      cleanupIntroducedPiCodingAgentPackages(installPath, error);
      throw error;
    }
    const parallelRuntimes = findPhysicalPiCodingAgentPackages(installPath);
    if (parallelRuntimes.length > 0) {
      cleanupIntroducedPiCodingAgentPackages(installPath);
      throw new CliError(
        `managed Git extension install introduced and removed a parallel Pi runtime: ${parallelRuntimes.join(", ")}`,
        1,
      );
    }
  }
}

function assertNoPhysicalPiCodingAgentPackages(root, phase) {
  const found = findPhysicalPiCodingAgentPackages(root);
  if (found.length === 0) return;
  throw new CliError(`managed extension tree contains a parallel Pi runtime ${phase}: ${found.join(", ")}`, 1);
}

function cleanupIntroducedPiCodingAgentPackages(root, originalError = null) {
  const found = findPhysicalPiCodingAgentPackages(root);
  for (const candidate of found) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch (cleanupError) {
      const original = originalError ? ` after ${originalError.message || originalError}` : "";
      throw new CliError(
        `could not remove an introduced parallel Pi runtime${original}: ${candidate}: ${cleanupError.message || cleanupError}`,
        1,
      );
    }
  }
  const remaining = findPhysicalPiCodingAgentPackages(root);
  if (remaining.length > 0) {
    const original = originalError ? ` after ${originalError.message || originalError}` : "";
    throw new CliError(
      `parallel Pi runtime cleanup was incomplete${original}: ${remaining.join(", ")}`,
      1,
    );
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

function applyCompatibilityPatch(ctx, entry, sourceRoot, commandRunner = runCommand, commandStdio) {
  const patchers = {
    "pi-until-done": "pi67-patch-pi-until-done-runtime-queue.mjs",
    "pi-smart-fetch": "pi67-patch-pi-smart-fetch-charset.mjs",
  };
  const patcher = patchers[entry.id];
  if (!patcher) return;
  const file = path.join(sourceRoot, "scripts", patcher);
  if (!fs.existsSync(file)) throw new CliError(`managed extension compatibility patcher is missing: ${file}`, 2);
  commandRunner(
    process.execPath,
    [file, "--apply", "--agent-dir", ctx.agentDir],
    commandRunOptions({ commandStdio }),
  );
}

function commandRunOptions(options, cwd) {
  return {
    ...(cwd ? { cwd } : {}),
    ...(options.commandStdio ? { stdio: options.commandStdio } : {}),
  };
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
  const filtered = new Set((probe.filteredSpecs || []).map(settingsSpecIdentity));
  return entries.map((entry) => {
    if (!entry.settingsSpec) return { ...entry, loadStatus: "not-applicable" };
    if (!entry.configured || entry.status === "missing") return { ...entry, loadStatus: "not-configured" };
    if (loaded.has(settingsSpecIdentity(entry.settingsSpec))) return { ...entry, loadStatus: "loaded" };
    if (filtered.has(settingsSpecIdentity(entry.settingsSpec))) return { ...entry, loadStatus: "filtered" };
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
    filtered: 0,
    loadFailed: 0,
    unknown: unknown.length,
    automaticActions: 0,
  };
  for (const entry of entries) {
    if (entry.loadStatus === "filtered") summary.filtered += 1;
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

export function settingsPackageSource(entry) {
  if (typeof entry === "string") return entry.trim();
  if (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.source === "string"
  ) {
    return entry.source.trim();
  }
  return "";
}

export function settingsSpecIdentity(spec) {
  const value = settingsPackageSource(spec);
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
  if (entry.sourceKind === "npm") validateRuntimeDependencies(entry);
  if (entry.sourceKind === "git" && !/^[0-9a-f]{40}$/.test(entry.minimumCommit || "")) {
    throw new CliError(`git extension baseline ${entry.id} requires a 40-character minimumCommit`, 2);
  }
  if (
    entry.sourceKind === "bundled"
      && (
        !entry.bundlePath
        || !entry.minimumVersion
        || !entry.contentHash
        || !Number.isInteger(entry.contentRevision)
        || entry.contentRevision < 1
      )
  ) {
    throw new CliError(
      `bundled extension baseline ${entry.id} requires bundlePath, minimumVersion, contentRevision, and contentHash`,
      2,
    );
  }
}

function needsBundledLedgerRefresh(entry, prior) {
  const revision = positiveIntegerOrNull(entry.contentRevision);
  return entry.sourceKind === "bundled"
    && entry.status === "at-baseline"
    && revision !== null
    && (
      prior?.lastManagedRevision !== revision
      || prior?.releaseBaselineRevision !== revision
    );
}

function positiveIntegerOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function validateRuntimeDependencies(entry) {
  const dependencies = entry.runtimeDependencies;
  if (dependencies === undefined) return;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new CliError(`npm extension baseline ${entry.id} runtimeDependencies must be an object`, 2);
  }
  for (const [packageName, version] of Object.entries(dependencies)) {
    if (!packageName || packageName === entry.packageName || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version || "")) {
      throw new CliError(`npm extension baseline ${entry.id} has an invalid runtime dependency: ${packageName || "unknown"}`, 2);
    }
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
