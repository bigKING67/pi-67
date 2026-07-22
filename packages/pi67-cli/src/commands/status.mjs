import { parseCommandOptions } from "../lib/args.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export async function statusCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "no-remote"],
  });
  if (options.help) {
    printStatusHelp();
    return;
  }
  const plan = await buildUpdatePlan(ctx, { noRemote: ctx.noRemote || options.noRemote });
  if (ctx.json || options.json) {
    printJson(plan);
    return;
  }
  section("pi-67 status");
  keyValue("Distro", plan.distro.version || "unknown");
  keyValue("State dir", plan.paths.stateDir);
  keyValue("Git", plan.git?.isRepo ? `${plan.git.branchLine || plan.git.branch || ""} ${plan.git.commit || ""}` : "not a git repo");
  keyValue("Provider", plan.settings.defaultProvider || "unset");
  keyValue("Model", plan.settings.defaultModel || "unset");
  keyValue("Theme", plan.settings.theme || "unset");
  const extensions = plan.extensions.summary;
  keyValue("Default extensions", `${extensions.atBaseline} baseline, ${extensions.missing} missing, ${extensions.belowBaseline} behind, ${extensions.userManagedAhead} ahead preserved, ${extensions.userManagedDiverged} modified preserved`);
  keyValue("Shared skills", `${plan.skills.identical} ok, ${plan.skills.missing} missing, ${preservedUserModified(plan.skills)} preserved user-modified`);
  printSkillPackStatus(plan.skillPacks);
  if (plan.warnings?.length) {
    section("Warnings");
    for (const message of plan.warnings) warn(message);
  }
  if (plan.recommendations?.length) {
    section("Recommendations");
    for (const message of plan.recommendations) info(message);
  }
}

function printSkillPackStatus(status) {
  if (!status?.registry?.valid) {
    keyValue("Skill Packs", `invalid (${status?.errors?.[0] || "registry error"})`);
    return;
  }
  if (!status.packs?.length) {
    keyValue("Skill Packs", "none registered");
    return;
  }
  for (const pack of status.packs) {
    const detail = pack.consistent
      ? "consistent"
      : `missing=${pack.missing}, conflicts=${pack.conflicts}`;
    keyValue("Skill Pack", `${pack.name}@${pack.version} ${detail}`);
  }
}

function preservedUserModified(skills) {
  return skills?.preservedUserModified ?? skills?.conflicts ?? 0;
}

function printStatusHelp() {
  process.stdout.write(`pi-67 status - read-only status summary

Usage:
  pi-67 status [--json] [--no-remote]

Options:
  --json       Emit the full update-plan status JSON.
  --no-remote  Skip remote git/npm registry checks.

Examples:
  pi-67 status
  pi-67 status --json --no-remote
`);
}
