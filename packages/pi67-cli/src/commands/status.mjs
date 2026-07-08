import { parseCommandOptions } from "../lib/args.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { printJson, section, keyValue } from "../lib/output.mjs";

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
  keyValue("Git", plan.git?.isRepo ? `${plan.git.branchLine || plan.git.branch || ""} ${plan.git.commit || ""}` : "not a git repo");
  keyValue("Provider", plan.settings.defaultProvider || "unset");
  keyValue("Model", plan.settings.defaultModel || "unset");
  keyValue("Theme", plan.settings.theme || "unset");
  keyValue("Shared skills", `${plan.skills.identical} ok, ${plan.skills.missing} missing, ${preservedUserModified(plan.skills)} preserved user-modified`);
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
