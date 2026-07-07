import fs from "node:fs";
import path from "node:path";
import { gitStatus, remoteHead } from "./git.mjs";
import { currentTheme, hasTheme, listThemes } from "./theme-policy.mjs";
import { readJsonFileIfExists } from "./config-json.mjs";
import { listExternal } from "./external-repos.mjs";
import { inventorySkills } from "./skill-policy.mjs";
import { readCliPackageJson, readTextIfExists } from "./paths.mjs";
import { npmLatestVersion } from "./npm-registry.mjs";
import { buildDistroManifest } from "./distro-manifest.mjs";
import { PRESERVED_RUNTIME_FILES } from "./update-safety.mjs";

export async function buildUpdatePlan(ctx, options = {}) {
  const versionFile = path.join(ctx.repoRoot, "VERSION");
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const theme = currentTheme(ctx);
  const themes = listThemes(ctx);
  const git = fs.existsSync(ctx.repoRoot) ? gitStatus(ctx.repoRoot) : { isRepo: false };
  const remote = !options.noRemote && git?.isRepo ? remoteHead(ctx.repoRoot) : { skipped: true };
  const skills = inventorySkills(ctx);
  const external = listExternal(ctx);
  const manifest = buildDistroManifest(ctx);
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
  const pkg = readCliPackageJson();
  const managerRegistry = await npmLatestVersion(pkg.name, {
    currentVersion: pkg.version,
    noRemote: options.noRemote,
  });

  const recommendations = [];
  if (managerRegistry.outdated) {
    recommendations.push(`Update pi-67 manager: npm install -g ${pkg.name}@latest`);
    recommendations.push(`Always-fresh one-shot: npx -y ${pkg.name}@latest update --repair`);
  }
  if (!fs.existsSync(ctx.repoRoot)) {
    recommendations.push("Run: pi-67 install");
  } else if (!git?.isRepo) {
    recommendations.push("Agent dir exists but is not a git checkout; inspect before installing.");
  } else if (git.dirty) {
    recommendations.push("Resolve or commit local changes before pi-67 update.");
  } else {
    recommendations.push("Run: pi-67 update");
  }
  if (skills.summary.conflicts > 0) {
    recommendations.push("Run: pi-67 skills inventory and resolve differing global skills manually.");
  }
  if (theme && !hasTheme(ctx, theme)) {
    recommendations.push(`Current theme is missing: ${theme}. Run: pi-67 themes list`);
  }
  if (manifest.summary.userManagedRuntimePackages > 0) {
    recommendations.push("User-managed Pi runtime packages detected; pi-67 will report them but not overwrite them by default.");
  }
  const decisions = buildPlanDecisions({
    ctx,
    git,
    managerRegistry,
    manifest,
    skills,
    external,
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
    },
    paths: {
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      skillsDir: ctx.skillsDir,
      packagesDir: ctx.packagesDir,
    },
    distro: {
      version: readTextIfExists(versionFile).trim(),
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
    skills: skills.summary,
    external,
    actions: decisions.actions,
    blocked: decisions.blocked,
    warnings: decisions.warnings,
    recommendations,
  };
}

export function buildPlanDecisions(context) {
  const actions = [];
  const blocked = [];
  const warnings = [];
  const preservedRuntimeFiles = [
    ...new Set([...(context.manifest.runtimeFiles?.preserve || []), ...PRESERVED_RUNTIME_FILES]),
  ];
  const dirty = classifyGitShort(context.git?.short || "");

  if (context.managerRegistry.outdated) {
    actions.push({
      id: "pi67-manager",
      kind: "npm-manager",
      operation: "self-update",
      writes: ["global npm package @bigking67/pi-67"],
      preserves: ["upstream pi binary"],
      risk: "low",
      reason: "npm registry has a newer pi-67 manager version",
      explicitCommand: "pi-67 self-update",
    });
  }

  if (!context.git?.isRepo) {
    blocked.push({
      id: "repo-root",
      kind: "distro",
      reason: "repo root is not a git checkout; install/update needs operator inspection first",
      recovery: "pi-67 install",
    });
  } else if (context.git.dirty && dirty.unsafeTracked.length > 0) {
    blocked.push({
      id: "repo-root",
      kind: "distro",
      reason: `repo has non-runtime local changes; pi-67 update blocks by default to avoid overwriting local work: ${dirty.unsafeTracked.join(", ")}`,
      recovery: "commit/stash intentional changes or rerun the script-level updater with an explicit dirty override",
    });
  } else if (context.git.dirty && dirty.preservedRuntime.length > 0) {
    actions.push({
      id: "user-runtime-config",
      kind: "runtime-config",
      operation: "backup-and-restore-during-update",
      writes: ["~/.pi/pi67/backups/<timestamp>-update"],
      preserves: dirty.preservedRuntime,
      risk: "low",
      reason: "only user-owned runtime config files are dirty; update snapshots and restores them instead of overwriting",
    });
    warnings.push(`dirty user runtime config will be preserved across update: ${dirty.preservedRuntime.join(", ")}`);
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
    const conflictMessage = `${context.skills.summary.conflicts} shared skills differ from the bundled baseline`;
    if (context.strictSharedSkills) {
      blocked.push({
        id: "shared-skills",
        kind: "skill-pack",
        reason: `${conflictMessage}; strict mode blocks instead of overwriting`,
        recovery: "inspect with pi-67 skills inventory, then sync or resolve manually",
      });
    } else {
      warnings.push(`${conflictMessage}; default update preserves existing different skills`);
    }
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
