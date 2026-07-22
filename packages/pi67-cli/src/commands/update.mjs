import { parseCommandOptions } from "../lib/args.mjs";
import { applyManagedExtensionBaselines } from "../lib/managed-extensions.mjs";
import { activateDistroRelease, resolveDistroSourceRoot } from "../lib/release-store.mjs";
import { syncSkills } from "../lib/skill-policy.mjs";
import { migrateSettingsRuntimeState } from "../lib/settings-runtime-state.mjs";
import { writeState } from "../lib/state-store.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { beginUpdateLifecycle } from "../lib/update-safety.mjs";
import { CliError, info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export async function updateCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: [
      "check",
      "repair",
      "dry-run",
      "json",
      "no-remote",
      "no-npm",
      "include-external",
      "strict-shared-skills",
      "verbose",
    ],
  });
  if (options.help) return printUpdateHelp();
  if (ctx.yes) {
    throw new CliError("pi-67 update does not use --yes; run `pi-67 update` or `pi-67 update --repair` without it", 2);
  }
  const dryRun = ctx.dryRun || options.dryRun;
  const json = ctx.json || options.json;
  const sourceRoot = resolveDistroSourceRoot(ctx);
  const plan = await buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
    sourceRoot,
    deepExtensions: true,
  });
  if (options.check) {
    if (json) return printJson(plan);
    printPlan(plan);
    return;
  }
  assertPlanCanProceed(plan);

  const lifecycle = beginUpdateLifecycle(ctx, {
    operation: options.repair ? "repair" : "update",
    dryRun,
    plan,
    backupRuntime: true,
  });
  try {
    const activation = activateDistroRelease(ctx, {
      sourceRoot,
      dryRun,
      operation: options.repair ? "repair" : "update",
    });
    const activeSource = dryRun ? sourceRoot : (activation.releasePath || sourceRoot);
    const extensions = applyManagedExtensionBaselines(ctx, {
      sourceRoot: activeSource,
      dryRun,
      skipNpm: options.noNpm,
    });
    const skills = syncSkills({ ...ctx, repoRoot: activeSource }, { dryRun });
    const runtimeState = dryRun ? null : migrateSettingsRuntimeState(ctx, {
      normalizeSettingsJson: true,
      installGitFilter: false,
    });
    if (!dryRun) writeState(ctx, options.repair ? "repair" : "update");
    const result = {
      schema: "pi67.update.v1",
      createdAt: new Date().toISOString(),
      dryRun,
      activation,
      extensions,
      skills: { summary: skills.summary, actions: skills.actions },
      runtimeState,
      runtimeBackup: lifecycle.backupDir || "",
    };
    if (json) return printJson(result);
    printResult(result);
  } finally {
    lifecycle.release();
  }

  if (options.includeExternal) {
    warn("External repo updates remain explicit: run `pi-67 external update <name>`.");
  }
}

function assertPlanCanProceed(plan) {
  const remaining = plan.blocked || [];
  if (remaining.length === 0) return;
  for (const item of remaining) warn(`${item.id}: ${item.reason}`);
  if (remaining.some((item) => item.id === "pi67-manager")) {
    throw new CliError(
      `pi-67 manager is outdated; run \`pi-67 self-update\` or \`npm install -g ${plan.manager.package}@latest\`, then rerun \`pi-67 update\``,
      2,
    );
  }
  throw new CliError("pi-67 update is blocked; run `pi-67 update --check` for the full plan", 2);
}

function printResult(result) {
  section("pi-67 update");
  keyValue("Distro", result.activation.version);
  keyValue("Immutable release", result.activation.releasePath);
  keyValue("Extension actions", result.extensions.applied.length);
  keyValue("Ahead extensions preserved", result.extensions.before.summary.userManagedAhead);
  keyValue("Modified extensions preserved", result.extensions.before.summary.userManagedDiverged);
  keyValue("Missing Skills copied", result.skills.actions.filter((item) => ["copy", "copy-dry-run"].includes(item.action)).length);
  if (result.runtimeBackup) keyValue("Runtime backup", result.runtimeBackup);
  info(result.dryRun ? "Dry run completed; no files were changed." : "Update completed without managing the Pi runtime version.");
}

function printPlan(plan) {
  section("pi-67 update check");
  keyValue("Manager", `${plan.manager.package}@${plan.manager.version}`);
  keyValue("Distro", plan.distro.version || "unknown");
  const extensions = plan.extensions.summary;
  keyValue(
    "Default extensions",
    `${extensions.atBaseline} baseline, ${extensions.missing} missing, ${extensions.belowBaseline} behind, ${extensions.userManagedAhead} ahead preserved, ${extensions.userManagedDiverged} modified preserved`,
  );
  keyValue("Shared Skills", `${plan.skills.identical} baseline, ${plan.skills.missing} missing, ${preservedUserModified(plan.skills)} modified preserved`);
  if (plan.actions.length > 0) {
    section("Planned safe actions");
    for (const action of plan.actions) info(`${action.id}: ${action.operation}`);
  }
  if (plan.blocked.length > 0) {
    section("Blocked actions");
    for (const item of plan.blocked) warn(`${item.id}: ${item.reason}`);
  }
  if (plan.warnings.length > 0) {
    section("Warnings");
    for (const item of plan.warnings) warn(item);
  }
  if (plan.recommendations.length > 0) {
    section("Recommendations");
    for (const item of plan.recommendations) info(item);
  }
}

function preservedUserModified(skills) {
  return skills?.preservedUserModified ?? skills?.conflicts ?? 0;
}

function printUpdateHelp() {
  process.stdout.write(`pi-67 update - activate this manager's immutable distro safely

Usage:
  pi-67 update [--repair] [--dry-run] [--no-remote] [--no-npm]
  pi-67 update --check [--json] [--no-remote]

The command does not clone/pull GitHub and does not install, compare, recommend,
or update the Pi runtime. It manages only pi-67 configuration, default
extensions, Skills, rules, prompts, templates, and first-party assets.

Default extension policy:
  missing -> install release baseline
  safely behind -> upgrade to release baseline
  equal -> keep
  newer -> keep; never downgrade
  modified/diverged/unknown -> keep and report conflict
`);
}
