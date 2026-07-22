import fs from "node:fs";
import path from "node:path";
import { gitStatus, gitText, remoteHead } from "./git.mjs";
import { currentTheme, hasTheme, listThemes } from "./theme-policy.mjs";
import { readJsonFileIfExists } from "./config-json.mjs";
import { listExternal } from "./external-repos.mjs";
import { inspectSkillPackStatus, inventorySkills } from "./skill-policy.mjs";
import { readTextIfExists } from "./paths.mjs";
import { inspectManagerFreshness, managerFreshnessBlockReason } from "./manager-freshness.mjs";
import { buildDistroManifest } from "./distro-manifest.mjs";
import { PRESERVED_RUNTIME_FILES } from "./update-safety.mjs";
import { settingsRuntimeMarkerFromObject } from "./settings-runtime-state.mjs";
import { inspectManagedExtensions } from "./managed-extensions.mjs";

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
  const managedExtensions = inspectManagedExtensions(ctx, {
    sourceRoot: options.sourceRoot || ctx.repoRoot,
    deepHash: Boolean(options.deepExtensions),
  });
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
  if (!fs.existsSync(ctx.agentDir)) {
    recommendations.push("Run: pi-67 install");
  } else if (git.dirty && benignRuntime.benign) {
    recommendations.push("No manual action required for benign settings runtime markers; pi-67 migrates lastChangelogVersion to ignored state during update/repair.");
  } else if (git.dirty) {
    recommendations.push("No manual action required for user runtime config; immutable release activation excludes and preserves it.");
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
  if (managedExtensions.summary.automaticActions > 0) {
    recommendations.push("Run: pi-67 update; missing or safely behind default extensions will be installed to the release minimum baseline.");
  }
  if (managedExtensions.summary.userManagedDiverged > 0) {
    recommendations.push("Run: pi-67 extensions status; user-modified extension conflicts are preserved and require explicit restore to replace.");
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
    managedExtensions,
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
      stateDir: ctx.stateDir,
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
    extensions: managedExtensions,
    skills: skills.summary,
    skillPacks,
    runtimeState: {
      settingsLastChangelogVersion: settingsRuntimeMarker?.value || "",
      storage: path.join(ctx.stateDir, "state.json"),
      policy: "settings.json lastChangelogVersion is runtime-only and is normalized into ignored state on update/repair",
    },
    external,
    actions: decisions.actions,
    blocked: decisions.blocked,
    warnings: decisions.warnings,
    recommendations,
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
      writes: [path.join(context.ctx.stateDir, "state.json"), "settings.json only when removing runtime-only lastChangelogVersion"],
      preserves: ["settings.json.theme", "settings.json.defaultProvider", "settings.json.defaultModel", "settings.json.packages"],
      risk: "low",
      reason: "lastChangelogVersion is Pi runtime UI state, not pi-67 source configuration",
      benign: true,
    });
  }

  if (context.git?.dirty && dirty.preservedRuntime.length > 0) {
    actions.push({
      id: "user-runtime-config",
      kind: "runtime-config",
      operation: "preserve-in-place-no-overwrite",
      writes: [],
      preserves: dirty.preservedRuntime,
      risk: "low",
      reason: benignRuntime.benign
        ? `benign runtime marker only: ${benignRuntime.reasons.join("; ")}`
        : "runtime configuration is user-owned and excluded from release activation",
      benign: benignRuntime.benign,
      benignReasons: benignRuntime.reasons,
      createsNewBackup: false,
      backupCondition: "none: immutable release activation excludes preserved runtime files",
    });
    warnings.push(
      `user runtime config is preserved outside release ownership: ${dirty.preservedRuntime.join(", ")}`,
    );
  }
  if (context.git?.dirty && dirty.untracked.length > 0) {
    warnings.push(`untracked files are present and will be preserved unless Git reports a path collision: ${dirty.untracked.join(", ")}`);
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

  const managedExtensions = context.managedExtensions || { summary: {}, extensions: [] };
  const extensionsNeedingSync = managedExtensions.extensions.filter((item) =>
    ["install", "upgrade", "configure"].includes(item.action));
  if (extensionsNeedingSync.length > 0) {
    actions.push({
      id: "managed-extensions",
      kind: "managed-extension-baseline",
      operation: "apply-missing-and-safe-behind-minimums",
      writes: extensionsNeedingSync.map((item) => item.installPath || item.settingsSpec),
      preserves: [
        ...preservedRuntimeFiles,
        "extensions newer than the release baseline",
        "extensions with user-modified source, ref, or content",
        "unknown third-party extensions",
      ],
      risk: "low",
      reason: `${extensionsNeedingSync.length} default extension(s) are missing, unconfigured, or safely behind the release minimum baseline`,
      explicitCommand: "pi-67 update",
    });
  }
  for (const item of managedExtensions.extensions.filter((entry) => entry.status === "user-managed-diverged")) {
    warnings.push(
      `default extension ${item.id} differs from the last pi-67-managed copy; preserving it without overwrite`,
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
