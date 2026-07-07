import { parseCommandOptions } from "../lib/args.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { printJson, section, keyValue, pass, warn, info } from "../lib/output.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { writeState } from "../lib/state-store.mjs";

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
  const dryRun = ctx.dryRun || options.dryRun;
  const json = ctx.json || options.json;
  if (options.check) {
    const plan = buildUpdatePlan(ctx, {
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

  const args = isWindows()
    ? buildWindowsUpdateArgs(ctx, options, dryRun)
    : buildBashUpdateArgs(ctx, options, dryRun);
  runDistroScript(ctx, { sh: "pi67-update.sh", ps1: "pi67-update.ps1" }, args, { dryRun: false });
  if (!dryRun) writeState(ctx, options.repair ? "repair" : "update");

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

function buildBashUpdateArgs(ctx, options, dryRun) {
  const args = ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (dryRun) args.push("--dry-run");
  if (options.repair) args.push("--force-npm");
  if (options.noNpm) args.push("--no-npm");
  if (options.allowDirty) args.push("--allow-dirty");
  if (options.strictSharedSkills) args.push("--strict-shared-skills");
  return args;
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
  keyValue("Shared skills", `${plan.skills.identical} ok, ${plan.skills.missing} missing, ${plan.skills.conflicts} conflicts`);
  for (const repo of plan.external) {
    keyValue(`External ${repo.name}`, repo.exists ? `${repo.git?.dirty ? "dirty" : "clean"} ${repo.git?.commit || ""}` : "missing");
  }
  if (plan.actions?.length > 0) {
    section("Planned safe actions");
    for (const action of plan.actions) {
      info(`${action.id}: ${action.operation}; writes=${action.writes.join(", ")}; preserves=${action.preserves.join(", ")}`);
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
