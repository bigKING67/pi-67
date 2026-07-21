import fs from "node:fs";
import path from "node:path";
import { gitStatus, gitText, remoteHead } from "./git.mjs";
import { currentTheme, hasTheme, listThemes } from "./theme-policy.mjs";
import { readJsonFileIfExists } from "./config-json.mjs";
import { listExternal } from "./external-repos.mjs";
import { inspectSkillPackStatus, inventorySkills } from "./skill-policy.mjs";
import { readTextIfExists } from "./paths.mjs";
import {
  compareSemver,
  npmLatestVersion,
  versionFromRange,
  versionSatisfiesSupportedRange,
} from "./npm-registry.mjs";
import { inspectManagerFreshness, managerFreshnessBlockReason } from "./manager-freshness.mjs";
import { buildDistroManifest } from "./distro-manifest.mjs";
import { PRESERVED_RUNTIME_FILES } from "./update-safety.mjs";
import { settingsRuntimeMarkerFromObject } from "./settings-runtime-state.mjs";
import { inspectUpstreamPiRuntime } from "./upstream-pi-runtime.mjs";

export async function buildUpdatePlan(ctx, options = {}) {
  const versionFile = path.join(ctx.repoRoot, "VERSION");
  const managerFreshness = await inspectManagerFreshness(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
  });
  const pkg = {
    name: managerFreshness.package,
    version: managerFreshness.managerVersion,
  };
  const managerRegistry = managerFreshness.registry;
  const distroVersion = managerFreshness.distroVersion;
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const theme = currentTheme(ctx);
  const themes = listThemes(ctx);
  const git = fs.existsSync(ctx.repoRoot) ? gitStatus(ctx.repoRoot) : { isRepo: false };
  const remote = !options.noRemote && git?.isRepo ? remoteHead(ctx.repoRoot) : { skipped: true };
  const skills = inventorySkills(ctx);
  const skillPacks = inspectSkillPackStatus(ctx, { inventory: skills });
  const external = listExternal(ctx);
  const manifest = buildDistroManifest(ctx);
  const [upstreamPi, packageAudit] = await Promise.all([
    inspectUpstreamPiRuntime(ctx, {
      manifest,
      noRemote: ctx.noRemote || options.noRemote,
    }),
    auditManagedDependencyPackages(ctx, manifest, {
      noRemote: ctx.noRemote || options.noRemote,
    }),
  ]);
  const requiredScripts = [
    "pi67-update.sh",
    "pi67-update.ps1",
    "pi67-doctor.sh",
    "pi67-doctor.ps1",
    "pi67-smoke.sh",
    "pi67-smoke.ps1",
    "pi67-report.sh",
    "pi67-report.ps1",
  ];
  const scriptStatus = Object.fromEntries(requiredScripts.map((name) => [
    name,
    fs.existsSync(path.join(ctx.repoRoot, "scripts", name)),
  ]));
  const settingsRuntimeMarker = settingsRuntimeMarkerFromObject(settings);
  const dirtyClass = classifyGitShort(git?.short || "");
  const benignRuntime = classifyBenignRuntimeDiff(ctx, dirtyClass.preservedRuntime);

  const recommendations = [];
  if (managerFreshness.blocking) {
    recommendations.push(`Update pi-67 manager first: ${managerFreshness.updateCommand}`);
    recommendations.push(`Then rerun: pi-67 update`);
    recommendations.push(`Always-fresh one-shot: ${managerFreshness.oneShotCommand}`);
  } else if (managerRegistry.outdated) {
    recommendations.push(`Update pi-67 manager: npm install -g ${pkg.name}@latest`);
    recommendations.push(`Always-fresh one-shot: npx -y ${pkg.name}@latest update`);
  }
  if (!fs.existsSync(ctx.repoRoot)) {
    recommendations.push("Run: pi-67 install");
  } else if (!git?.isRepo) {
    recommendations.push("Agent dir exists but is not a git checkout; preview repair with: pi-67 install --repair --yes --dry-run");
    recommendations.push("If the preview looks correct, run: pi-67 install --repair --yes");
  } else if (git.dirty && dirtyClass.unsafeTracked.length > 0) {
    recommendations.push("Resolve or commit local changes before pi-67 update.");
  } else if (git.dirty && benignRuntime.benign) {
    recommendations.push("No manual action required for benign settings runtime markers; pi-67 migrates lastChangelogVersion to ignored state during update/repair.");
  } else if (git.dirty) {
    recommendations.push("No manual action required for user runtime config; pi-67 backs up/restores it during update.");
  } else {
    const recommendation = cleanDistroUpdateRecommendation(git, remote);
    if (recommendation) recommendations.push(recommendation);
  }
  if (skills.summary.conflicts > 0) {
    recommendations.push("Run: pi-67 skills inventory to inspect preserved user-modified global skills.");
  }
  if (!skillPacks.registry.valid || !skillPacks.lock?.valid) {
    recommendations.push("Run: pi-67 skills packs to inspect the shared Skill Pack registry or provenance lock error.");
  } else {
    const inconsistentPacks = skillPacks.packs.filter((entry) => !entry.consistent);
    if (inconsistentPacks.length > 0) recommendations.push(`Run: ${inconsistentPacks[0].commands.inspect}`);
    for (const pack of inconsistentPacks) {
      recommendations.push(`Preview: ${pack.commands.preview}`);
    }
  }
  if (theme && !hasTheme(ctx, theme)) {
    recommendations.push(`Current theme is missing: ${theme}. Run: pi-67 themes list`);
  }
  if (manifest.summary.userManagedRuntimePackages > 0) {
    recommendations.push("User-managed Pi runtime packages detected; pi-67 will report them but not overwrite them by default.");
  }
  if (!upstreamPi.commandOk) {
    recommendations.push(`Install upstream Pi: ${upstreamPi.updateCommand}`);
  } else if (upstreamPi.installedBehindTested) {
    recommendations.push(`Update upstream Pi to the release-tested baseline: ${upstreamPi.updateCommand}`);
  } else if (upstreamPi.installedVersion && upstreamPi.registry.outdated) {
    recommendations.push(`Upstream Pi ${upstreamPi.installedVersion} has registry latest ${upstreamPi.registry.latestVersion}; review upstream changes before updating.`);
  }
  if (packageAudit.summary.baselineBehindLatest > 0) {
    const names = packageAudit.packages
      .filter((item) => item.baselineBehindLatest)
      .map((item) => `${item.packageName}@${item.latestVersion}`)
      .join(", ");
    recommendations.push(`pi-67 release should adopt newer managed package baselines after smoke: ${names}`);
  }
  if ((packageAudit.summary.installedDrift || 0) > 0 || (packageAudit.summary.notInstalled || 0) > 0) {
    recommendations.push("Run: pi-67 update; normal update automatically syncs missing or different managed npm packages to the release lock.");
  }
  const decisions = buildPlanDecisions({
    ctx,
    git,
    benignRuntime,
    settingsRuntimeMarker,
    manager: pkg,
    managerFreshness,
    managerBehindLocalDistro: managerFreshness.managerBehindLocalDistro,
    managerRegistry,
    remote,
    manifest,
    skills,
    external,
    packageAudit,
    scriptStatus,
    theme,
    themeInstalled: theme ? hasTheme(ctx, theme) : false,
    strictSharedSkills: Boolean(options.strictSharedSkills),
  });

  return {
    schema: "pi67.update-plan.v1",
    createdAt: new Date().toISOString(),
    manager: {
      package: pkg.name,
      version: pkg.version,
      registry: managerRegistry,
      freshness: {
        blocking: managerFreshness.blocking,
        managerBehindLocalDistro: managerFreshness.managerBehindLocalDistro,
        registryOutdated: managerFreshness.registryOutdated,
      },
    },
    paths: {
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      skillsDir: ctx.skillsDir,
      packagesDir: ctx.packagesDir,
    },
    distro: {
      version: distroVersion || readTextIfExists(versionFile).trim(),
    },
    git,
    remote,
    settings: {
      defaultProvider: settings.defaultProvider || "",
      defaultModel: settings.defaultModel || "",
      defaultThinkingLevel: settings.defaultThinkingLevel || "",
      theme,
      themeInstalled: theme ? hasTheme(ctx, theme) : false,
      themesAvailable: themes.length,
    },
    policy: {
      userConfigPolicy: manifest.ownership?.userManaged || "preserve user-managed runtime files",
      preservedRuntimeFiles: PRESERVED_RUNTIME_FILES,
      themePolicy: manifest.theme?.policy || "",
      sharedSkillsPolicy: manifest.sharedSkills?.policy || "",
      externalDirtyPolicy: manifest.externalReposPolicy?.dirtyRepo || "",
    },
    scripts: scriptStatus,
    manifest: manifest.summary,
    runtime: {
      upstreamPi,
    },
    packages: packageAudit,
    skills: skills.summary,
    skillPacks,
    runtimeState: {
      settingsLastChangelogVersion: settingsRuntimeMarker?.value || "",
      storage: "~/.pi/pi67/state.json",
      policy: "settings.json lastChangelogVersion is runtime-only and is normalized into ignored state on update/repair",
    },
    external,
    actions: decisions.actions,
    blocked: decisions.blocked,
    warnings: upstreamPiRuntimeWarnings(upstreamPi, decisions.warnings),
    recommendations,
  };
}

function upstreamPiRuntimeWarnings(runtime, warnings) {
  if (!runtime.commandOk) {
    return [...warnings, "upstream Pi command is missing or failed `pi --version`"];
  }
  if (runtime.installedBehindTested) {
    return [...warnings, `upstream Pi ${runtime.installedVersion} is behind release-tested ${runtime.testedVersion}`];
  }
  if (!runtime.installedVersion) {
    return [...warnings, "upstream Pi version could not be parsed"];
  }
  return warnings;
}

export async function auditManagedDependencyPackages(ctx, manifest, options = {}) {
  const packages = await Promise.all((manifest.dependencyPackages || []).map(async (item) => {
    const installedVersion = installedDependencyVersion(ctx, item.packageName);
    const baselineVersion = item.lockedVersion || versionFromRange(item.versionRange);
    const registry = await npmLatestVersion(item.packageName, {
      currentVersion: baselineVersion,
      noRemote: options.noRemote,
    });
    return classifyManagedDependencyPackage(item, { installedVersion, registry });
  }));
  const summary = {
    total: packages.length,
    current: packages.filter((item) => item.status === "current").length,
    baselineBehindLatest: packages.filter((item) => item.baselineBehindLatest).length,
    installedBehind: packages.filter((item) => item.installedBehindBaseline).length,
    installedAhead: packages.filter((item) => item.installedAheadBaseline).length,
    installedDrift: packages.filter((item) =>
      item.installedBehindBaseline || item.installedAheadBaseline).length,
    notInstalled: packages.filter((item) => item.status === "not-installed").length,
    registryUnknown: packages.filter((item) => item.status === "registry-unknown").length,
    registrySkipped: packages.filter((item) => item.status === "registry-skipped").length,
  };
  return {
    schema: "pi67.managed-package-audit.v1",
    remoteSkipped: Boolean(options.noRemote),
    summary,
    packages,
  };
}

export function classifyManagedDependencyPackage(item, options = {}) {
  const baselineVersion = item.lockedVersion || versionFromRange(item.versionRange);
  const installedVersion = String(options.installedVersion || "").trim();
  const registry = options.registry || { skipped: true, ok: false, latestVersion: "" };
  const latestVersion = registry.latestVersion || "";
  const latestSatisfiesRange = Boolean(latestVersion) &&
    versionSatisfiesSupportedRange(latestVersion, item.versionRange);
  const baselineBehindLatest = Boolean(registry.ok) &&
    Boolean(latestVersion) &&
    Boolean(baselineVersion) &&
    compareSemver(baselineVersion, latestVersion) < 0;
  const installedBehindBaseline = Boolean(installedVersion) &&
    Boolean(baselineVersion) &&
    compareSemver(installedVersion, baselineVersion) < 0;
  const installedAheadBaseline = Boolean(installedVersion) &&
    Boolean(baselineVersion) &&
    compareSemver(installedVersion, baselineVersion) > 0;
  const installedBehindRangeLatest = Boolean(installedVersion) &&
    Boolean(latestVersion) &&
    latestSatisfiesRange &&
    compareSemver(installedVersion, latestVersion) < 0;

  let status = "current";
  if (!installedVersion) status = "not-installed";
  else if (installedBehindBaseline) status = "installed-behind-baseline";
  else if (installedAheadBaseline) status = "installed-ahead-of-baseline";
  else if (registry.skipped) status = "registry-skipped";
  else if (!registry.ok) status = "registry-unknown";
  else if (baselineBehindLatest) status = "baseline-behind-latest";

  return {
    packageName: item.packageName,
    role: item.role,
    versionRange: item.versionRange,
    baselineVersion,
    baselineSource: item.lockedVersion ? "package-lock.json" : "package.json-range-floor",
    installedVersion,
    latestVersion,
    latestSatisfiesRange,
    baselineBehindLatest,
    installedBehindBaseline,
    installedAheadBaseline,
    installedBehindRangeLatest,
    status,
    registry,
  };
}

export function cleanDistroUpdateRecommendation(git, remote) {
  if (!git?.isRepo || git.dirty || remote?.skipped || !git.commit || !remote?.commit) return "";
  if (String(remote.commit).startsWith(String(git.commit))) return "";
  return "Run: pi-67 update; the remote branch differs from the local checkout.";
}

export function buildPlanDecisions(context) {
  const actions = [];
  const blocked = [];
  const warnings = [];
  const preservedRuntimeFiles = [
    ...new Set([...(context.manifest.runtimeFiles?.preserve || []), ...PRESERVED_RUNTIME_FILES]),
  ];
  const dirty = classifyGitShort(context.git?.short || "");
  const benignRuntime = context.benignRuntime || { benign: false, reasons: [] };
  const settingsRuntimeMarker = context.settingsRuntimeMarker || null;

  if (context.managerRegistry.outdated || context.managerBehindLocalDistro) {
    const packageName = context.manager?.name || "@bigking67/pi-67";
    actions.push({
      id: "pi67-manager",
      kind: "npm-manager",
      operation: "self-update",
      writes: [`global npm package ${packageName}`],
      preserves: ["upstream pi binary"],
      risk: "low",
      reason: context.managerBehindLocalDistro
        ? `active pi-67 manager is older than local distro ${context.managerFreshness?.distroVersion || "unknown"}`
        : "npm registry has a newer pi-67 manager version",
      explicitCommand: "pi-67 self-update",
    });
    blocked.push({
      id: "pi67-manager",
      kind: "npm-manager",
      reason: context.managerFreshness
        ? managerFreshnessBlockReason(context.managerFreshness)
        : "active pi-67 manager is outdated; update the npm manager before running distro update/repair",
      recovery: `npm install -g ${packageName}@latest`,
    });
  }

  if (settingsRuntimeMarker?.value || benignRuntime.benign) {
    actions.push({
      id: "settings-runtime-state",
      kind: "runtime-state",
      operation: "migrate-lastChangelogVersion-to-ignored-state",
      writes: ["~/.pi/pi67/state.json", "settings.json only when removing runtime-only lastChangelogVersion"],
      preserves: ["settings.json.theme", "settings.json.defaultProvider", "settings.json.defaultModel", "settings.json.packages"],
      risk: "low",
      reason: "lastChangelogVersion is Pi runtime UI state, not pi-67 source configuration",
      benign: true,
    });
  }

  if (!context.git?.isRepo) {
    blocked.push({
      id: "repo-root",
      kind: "distro",
      reason: "repo root is not a git checkout; pi-67 will not overwrite an existing plain folder silently",
      recovery: "pi-67 install --repair --yes",
    });
  } else if (context.git.dirty && dirty.unsafeTracked.length > 0) {
    blocked.push({
      id: "repo-root",
      kind: "distro",
      reason: `repo has non-runtime local changes; pi-67 update blocks by default to avoid overwriting local work: ${dirty.unsafeTracked.join(", ")}`,
      recovery: "commit/stash intentional changes or rerun the script-level updater with an explicit dirty override",
    });
  } else if (context.git.dirty && dirty.preservedRuntime.length > 0) {
    const remoteStatus = classifyIncomingRemoteStatus(context.git, context.remote);
    const preserveInPlace = remoteStatus.upToDate;
    actions.push({
      id: "user-runtime-config",
      kind: "runtime-config",
      operation: preserveInPlace
        ? "preserve-in-place-no-backup"
        : "conditional-backup-if-incoming-update-touches-runtime-config",
      writes: preserveInPlace
        ? []
        : ["~/.pi/pi67/backups/pre-update-runtime-* only if incoming update touches preserved runtime files"],
      preserves: dirty.preservedRuntime,
      risk: "low",
      reason: runtimeConfigActionReason({ benignRuntime, preserveInPlace, remoteStatus }),
      benign: benignRuntime.benign,
      benignReasons: benignRuntime.reasons,
      createsNewBackup: !preserveInPlace,
      backupCondition: preserveInPlace
        ? "none: remote already matches the local checkout"
        : "only when fetched incoming changes overlap preserved runtime files",
    });
    warnings.push(
      preserveInPlace
        ? `dirty user runtime config will stay in place; current remote is already at the local commit: ${dirty.preservedRuntime.join(", ")}`
        : (
          benignRuntime.benign
            ? `benign user runtime marker will be preserved; backup is conditional on incoming path overlap: ${dirty.preservedRuntime.join(", ")}`
            : `dirty user runtime config will be preserved; backup is conditional on incoming path overlap: ${dirty.preservedRuntime.join(", ")}`
        ),
    );
  }
  if (context.git?.dirty && dirty.untracked.length > 0) {
    warnings.push(`untracked files are present and will be preserved unless Git reports a path collision: ${dirty.untracked.join(", ")}`);
  }

  for (const item of context.manifest.localExtensions || []) {
    if (item.owner === "pi67-managed" && !item.exists) {
      actions.push({
        id: item.name,
        kind: "local-extension",
        operation: "repair",
        writes: [item.path],
        preserves: preservedRuntimeFiles,
        risk: "low",
        reason: "required pi-67 managed local extension is missing",
      });
    }
  }

  const missingScripts = Object.entries(context.scriptStatus)
    .filter(([, exists]) => !exists)
    .map(([name]) => `scripts/${name}`);
  if (missingScripts.length > 0) {
    actions.push({
      id: "distro-scripts",
      kind: "distro",
      operation: "repair",
      writes: missingScripts,
      preserves: preservedRuntimeFiles,
      risk: "low",
      reason: "required cross-platform helper scripts are missing",
    });
  }

  if (context.theme && !context.themeInstalled) {
    actions.push({
      id: "pi-curated-themes",
      kind: "theme-package",
      operation: "verify-or-install-assets",
      writes: ["npm/node_modules/@victor-software-house/pi-curated-themes"],
      preserves: ["settings.json.theme"],
      risk: "low",
      reason: `current theme ${context.theme} is selected but theme assets are missing`,
    });
    warnings.push(`theme ${context.theme} is not installed; update may install assets but will not change the selected theme`);
  }

  if (context.skills.summary.missing > 0) {
    actions.push({
      id: "shared-skills",
      kind: "skill-pack",
      operation: "copy-missing-only",
      writes: [`${context.ctx.skillsDir}/<missing-skill>`],
      preserves: [`${context.ctx.skillsDir}/<existing-different-skill>`],
      risk: "low",
      reason: `${context.skills.summary.missing} shared skills are missing from the active skills root`,
    });
  }
  if (context.skills.summary.conflicts > 0) {
    const conflictMessage = `${context.skills.summary.conflicts} preserved user-modified global skills differ from the bundled baseline`;
    if (context.strictSharedSkills) {
      blocked.push({
        id: "shared-skills",
        kind: "skill-pack",
        reason: `${conflictMessage}; strict mode blocks instead of overwriting user-modified skills`,
        recovery: "inspect with pi-67 skills inventory, then sync or resolve manually",
      });
    } else {
      warnings.push(`${conflictMessage}; default update preserves them`);
    }
  }

  const packageAudit = context.packageAudit || { summary: {}, packages: [] };
  const packagesNeedingSync = packageAudit.packages.filter((item) =>
    item.status === "installed-behind-baseline" ||
    item.status === "installed-ahead-of-baseline" ||
    item.status === "not-installed");
  if (packagesNeedingSync.length > 0) {
    actions.push({
      id: "managed-npm-packages",
      kind: "npm-package-sync",
      operation: "sync-to-release-lock",
      writes: ["npm/package.json", "npm/package-lock.json", "npm/node_modules"],
      preserves: preservedRuntimeFiles,
      risk: "low",
      reason: `${packagesNeedingSync.length} managed npm package(s) are missing or differ from the release-locked baseline`,
      explicitCommand: "pi-67 update",
    });
  }
  for (const item of packageAudit.packages.filter((entry) => entry.baselineBehindLatest)) {
    warnings.push(
      `managed package ${item.packageName} latest ${item.latestVersion} is newer than release-locked baseline ${item.baselineVersion} (range ${item.versionRange}); wait for a pi-67 release that updates the lock after smoke instead of running upstream pi update --extensions`,
    );
  }
  for (const repo of context.external) {
    if (!repo.exists) {
      warnings.push(`external repo ${repo.name} is missing; install is explicit via pi-67 external install ${repo.name}`);
      continue;
    }
    if (!repo.git?.isRepo) {
      blocked.push({
        id: repo.name,
        kind: "external-repo",
        reason: `${repo.path} exists but is not a git repo`,
        recovery: `inspect the path before running pi-67 external update ${repo.name}`,
      });
    } else if (repo.git.dirty) {
      blocked.push({
        id: repo.name,
        kind: "external-repo",
        reason: `external repo is dirty and will not be updated destructively: ${repo.path}`,
        recovery: `commit/stash the external repo or skip pi-67 external update ${repo.name}`,
      });
    } else if (!repo.git.branch) {
      blocked.push({
        id: repo.name,
        kind: "external-repo",
        reason: `external repo is detached and will not be updated destructively: ${repo.path}`,
        recovery: `checkout a branch before pi-67 external update ${repo.name}`,
      });
    }
  }

  return { actions, blocked, warnings };
}

function installedDependencyVersion(ctx, packageName) {
  const packageFile = path.join(ctx.agentDir, "npm", "node_modules", ...packageName.split("/"), "package.json");
  const pkg = readJsonFileIfExists(packageFile);
  return typeof pkg?.version === "string" ? pkg.version : "";
}

function classifyIncomingRemoteStatus(git, remote) {
  if (remote?.skipped) return { upToDate: false, known: false, reason: "remote check skipped" };
  if (!remote?.commit || !git?.commit) return { upToDate: false, known: false, reason: remote?.message || "remote commit unknown" };
  const local = String(git.commit);
  const remoteCommit = String(remote.commit);
  return {
    upToDate: remoteCommit.startsWith(local),
    known: true,
    reason: remoteCommit.startsWith(local)
      ? "remote already matches local commit"
      : "remote differs from local commit; updater will inspect changed paths after fetch",
  };
}

function runtimeConfigActionReason({ benignRuntime, preserveInPlace, remoteStatus }) {
  const prefix = benignRuntime.benign
    ? `benign runtime marker only: ${benignRuntime.reasons.join("; ")}`
    : "only user-owned runtime config files are dirty";
  if (preserveInPlace) {
    return `${prefix}; ${remoteStatus.reason}; no runtime backup is needed`;
  }
  return `${prefix}; updater fetches first and creates a runtime backup only if incoming changes touch these preserved files`;
}

export function classifyGitShort(short) {
  const preserved = new Set(PRESERVED_RUNTIME_FILES);
  const result = {
    preservedRuntime: [],
    unsafeTracked: [],
    untracked: [],
  };
  for (const line of String(short || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.startsWith("??") ? "??" : line.slice(0, 2);
    const file = parseStatusPath(line);
    if (!file) continue;
    if (status === "??") {
      result.untracked.push(file);
    } else if (preserved.has(file)) {
      result.preservedRuntime.push(file);
    } else {
      result.unsafeTracked.push(file);
    }
  }
  result.preservedRuntime = [...new Set(result.preservedRuntime)].sort();
  result.unsafeTracked = [...new Set(result.unsafeTracked)].sort();
  result.untracked = [...new Set(result.untracked)].sort();
  return result;
}

export function classifyBenignRuntimeDiff(ctx, preservedRuntimePaths = []) {
  const paths = [...new Set(preservedRuntimePaths)].sort();
  if (paths.length !== 1 || paths[0] !== "settings.json") {
    return { benign: false, reasons: [] };
  }
  const diff = gitText(ctx.repoRoot, ["diff", "--", "settings.json"]);
  if (!diff) return { benign: false, reasons: [] };
  const changed = diff.split(/\r?\n/).filter((line) =>
    (line.startsWith("+") || line.startsWith("-")) &&
    !line.startsWith("+++") &&
    !line.startsWith("---"));
  const meaningful = changed.filter((line) => {
    const body = line.slice(1).trim();
    return body !== "" && body !== "}";
  });
  const reasons = [];
  const markerOnly = meaningful.length > 0 &&
    meaningful.every((line) => /^[-+]\s*"lastChangelogVersion"\s*:/.test(line));
  if (markerOnly) {
    reasons.push("settings.json lastChangelogVersion runtime marker changed");
  }
  if (changed.some((line) => ["-", "+", "-}", "+}"].includes(line.trim()))) {
    reasons.push("settings.json trailing newline state changed");
  }
  return {
    benign: markerOnly || (meaningful.length === 0 && reasons.length > 0),
    reasons,
  };
}

function parseStatusPath(line) {
  let file = "";
  if (line.length >= 3 && line[2] === " ") {
    file = line.slice(3).trim();
  } else {
    file = line.replace(/^[ MARCUD?!]{1,2}\s+/, "").trim();
  }
  const arrow = " -> ";
  if (file.includes(arrow)) file = file.slice(file.indexOf(arrow) + arrow.length);
  if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
  return file.replace(/\\/g, "/");
}
