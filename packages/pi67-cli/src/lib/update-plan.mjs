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

export function buildUpdatePlan(ctx, options = {}) {
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
  const managerRegistry = npmLatestVersion(pkg.name, {
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

function buildPlanDecisions(context) {
  const actions = [];
  const blocked = [];
  const warnings = [];
  const preservedRuntimeFiles = context.manifest.runtimeFiles?.preserve || [];

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
  } else if (context.git.dirty) {
    blocked.push({
      id: "repo-root",
      kind: "distro",
      reason: "repo has local changes; pi-67 update blocks by default to avoid overwriting local work",
      recovery: "commit/stash intentional changes or rerun the script-level updater with an explicit dirty override",
    });
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
