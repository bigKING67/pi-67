import { parseCommandOptions } from "../lib/args.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { CliError, printJson, section, keyValue, pass, warn, info } from "../lib/output.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { writeState } from "../lib/state-store.mjs";
import { beginUpdateLifecycle } from "../lib/update-safety.mjs";
import { migrateSettingsRuntimeState } from "../lib/settings-runtime-state.mjs";

export async function updateCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: [
      "check",
      "repair",
      "dry-run",
      "json",
      "no-remote",
      "no-npm",
      "allow-dirty",
      "include-pi",
      "include-external",
      "all",
      "yes",
      "strict-shared-skills",
    ],
  });
  if (options.help) {
    printUpdateHelp();
    return;
  }
  const dryRun = ctx.dryRun || options.dryRun;
  const json = ctx.json || options.json;
  if (options.check) {
    const plan = await buildUpdatePlan(ctx, {
      noRemote: ctx.noRemote || options.noRemote,
      strictSharedSkills: options.strictSharedSkills,
    });
    if (json) {
      printJson(plan);
      return;
    }
    printPlan(plan);
    return;
  }

  const plan = await buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
  });
  assertPlanCanProceed(plan, { allowDirty: options.allowDirty });
  const lifecycle = beginUpdateLifecycle(ctx, {
    operation: options.repair ? "repair" : "update",
    dryRun,
    plan,
    backupRuntime: false,
  });
  if (!dryRun && lifecycle.backedUp.length > 0) {
    info(`Preserved runtime backup: ${lifecycle.backupDir}`);
  } else if (!dryRun && lifecycle.backupSkipped) {
    info(`Preserved runtime backup skipped: ${lifecycle.backupReason}`);
  }

  const args = isWindows()
    ? buildWindowsUpdateArgs(ctx, options, dryRun)
    : buildBashUpdateArgs(ctx, options, dryRun);
  try {
    runDistroScript(ctx, { sh: "pi67-update.sh", ps1: "pi67-update.ps1" }, args, { dryRun: false });
    if (!dryRun) {
      writeState(ctx, options.repair ? "repair" : "update");
      reportSettingsRuntimeStateMigration(ctx);
    }
  } finally {
    lifecycle.release();
  }

  if (options.includePi || options.all) {
    if (ctx.yes || options.yes) {
      runCommand("pi", ["update", "--all"], { dryRun });
    } else {
      warn("Pi upstream update skipped; rerun with --include-pi --yes if you really want `pi update --all`.");
    }
  }
  if (options.includeExternal || options.all) {
    warn("External repo updates are explicit; run `pi-67 external update browser67` or `pi-67 external update design-craft`.");
  }
}

function reportSettingsRuntimeStateMigration(ctx) {
  const result = migrateSettingsRuntimeState(ctx, {
    normalizeSettingsJson: true,
    installGitFilter: true,
  });
  if (result.markerFound && result.stateWritten) {
    info("Migrated settings.json lastChangelogVersion to ignored state: ~/.pi/pi67/state.json");
  }
  if (result.settingsNormalized) {
    info("Normalized settings.json by removing runtime-only lastChangelogVersion.");
  }
  if (result.gitFilterInstalled) {
    info("Installed local git clean filter for future settings.json runtime markers.");
  }
  for (const error of result.errors) {
    warn(`settings runtime marker migration skipped: ${error}`);
  }
}

function buildBashUpdateArgs(ctx, options, dryRun) {
  const args = ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (dryRun) args.push("--dry-run");
  if (options.repair) args.push("--force-npm");
  if (options.noNpm) args.push("--no-npm");
  if (options.allowDirty) args.push("--allow-dirty");
  if (options.strictSharedSkills) args.push("--strict-shared-skills");
  return args;
}

function assertPlanCanProceed(plan, options = {}) {
  if (options.allowDirty || !plan.blocked?.length) return;
  for (const item of plan.blocked) warn(`${item.id}: ${item.reason}`);
  throw new CliError("pi-67 update is blocked; run `pi-67 update --check` for the full plan or rerun with --allow-dirty if you accept the risk", 2);
}

function buildWindowsUpdateArgs(ctx, options, dryRun) {
  const args = ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir];
  if (dryRun) args.push("-DryRun");
  if (options.repair) args.push("-ForceNpm");
  if (options.noNpm) args.push("-NoNpm");
  if (options.allowDirty) args.push("-AllowDirty");
  if (options.strictSharedSkills) args.push("-StrictSharedSkills");
  return args;
}

function printPlan(plan) {
  section("pi-67 update check");
  keyValue("Agent dir", plan.paths.agentDir);
  keyValue("Repo root", plan.paths.repoRoot);
  keyValue("Manager", `${plan.manager.package}@${plan.manager.version}`);
  if (plan.manager.registry?.skipped) {
    keyValue("Manager latest", "skipped");
  } else if (plan.manager.registry?.ok) {
    keyValue("Manager latest", `${plan.manager.registry.latestVersion}${plan.manager.registry.outdated ? " update available" : ""}`);
  } else if (plan.manager.registry?.message) {
    keyValue("Manager latest", `unknown (${plan.manager.registry.message})`);
  }
  keyValue("Distro", plan.distro.version || "unknown");
  keyValue("Git", plan.git?.isRepo ? `${plan.git.branchLine || plan.git.branch || ""} ${plan.git.commit || ""}` : "not a git repo");
  keyValue("Dirty", plan.git?.dirty ? "yes" : "no");
  keyValue("Remote", plan.remote?.skipped ? "skipped" : (plan.remote?.commit || plan.remote?.message || "unknown"));
  keyValue("Provider", plan.settings.defaultProvider || "unset");
  keyValue("Model", plan.settings.defaultModel || "unset");
  keyValue("Theme", plan.settings.theme || "unset");
  keyValue("Theme installed", plan.settings.themeInstalled ? "yes" : "no");
  keyValue("Shared skills", `${plan.skills.identical} ok, ${plan.skills.missing} missing, ${preservedUserModified(plan.skills)} preserved user-modified`);
  for (const repo of plan.external) {
    keyValue(`External ${repo.name}`, repo.exists ? `${repo.git?.dirty ? "dirty" : "clean"} ${repo.git?.commit || ""}` : "missing");
  }
  if (plan.actions?.length > 0) {
    section("Planned safe actions");
    for (const action of plan.actions) {
      const writes = action.writes?.length ? action.writes.join(", ") : "none";
      const suffix = action.backupCondition ? `; backup=${action.backupCondition}` : "";
      info(`${action.id}: ${action.operation}; writes=${writes}; preserves=${action.preserves.join(", ")}${suffix}`);
    }
  }
  if (plan.blocked?.length > 0) {
    section("Blocked actions");
    for (const item of plan.blocked) warn(`${item.id}: ${item.reason}`);
  }
  if (plan.warnings?.length > 0) {
    section("Warnings");
    for (const item of plan.warnings) warn(item);
  }
  section("Recommendations");
  for (const item of plan.recommendations) info(item);
  if (!plan.git?.dirty) pass("update check completed without local dirty blocker");
}

function preservedUserModified(skills) {
  return skills?.preservedUserModified ?? skills?.conflicts ?? 0;
}

function printUpdateHelp() {
  process.stdout.write(`pi-67 update - update pi-67 safely

Usage:
  pi-67 update [--repair] [--dry-run] [--no-remote] [--no-npm]
  pi-67 update --check [--json] [--no-remote]

Options:
  --check                 Print the read-only update plan and exit.
  --repair                Re-run owned asset/config repair during update.
  --dry-run               Print planned script actions without changing files.
  --no-remote             Skip remote git/npm registry checks where supported.
  --no-npm                Skip npm package sync in the distro updater.
  --allow-dirty           Let the script-level updater handle non-runtime dirty files.
  --strict-shared-skills  Treat preserved user-modified shared skills as blocking.
  --include-pi            Also run upstream \`pi update --all\` when paired with --yes.
  --include-external      Report explicit external repo update commands.
  --all                   Alias for --include-pi --include-external.
  --yes                   Confirm explicit opt-in actions.
  --json                  Emit JSON for --check.

Safety:
  Runtime config backup/restore is owned by the platform updater script when
  dirty preserved runtime files overlap incoming changed paths. The npm manager
  owns the update lock and never creates a runtime backup for --help, a blocked
  update plan, or an already-up-to-date update.

Examples:
  pi-67 update --check
  pi-67 update --check --json --no-remote
  pi-67 update
  pi-67 update --repair
`);
}
