import { parseCommandOptions } from "../lib/args.mjs";
import { diffSkill, inventorySkills, planSkills, syncSkills } from "../lib/skill-policy.mjs";
import { CliError, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function skillsCommand(ctx, argv) {
  const [sub = "inventory", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printSkillsHelp();
    return;
  }
  if (sub === "inventory") return inventory(ctx, rest);
  if (sub === "plan") return plan(ctx, rest);
  if (sub === "diff") return diff(ctx, rest);
  if (sub === "sync") return sync(ctx, rest);
  if (sub === "migrate") return migrate(ctx, rest);
  throw new CliError(`unknown skills command: ${sub}`, 2);
}

function inventory(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printSkillsHelp();
  const data = inventorySkills(ctx);
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 shared skills inventory");
  keyValue("Source", data.sourceRoot);
  keyValue("Target", data.skillsDir);
  keyValue("Identical", data.summary.identical);
  keyValue("Missing", data.summary.missing);
  keyValue("Conflicts", data.summary.conflicts);
  for (const entry of data.entries.filter((item) => !item.identical)) {
    const status = entry.conflict ? "conflict" : "missing";
    info(`${status}: ${entry.name}`);
  }
}

function plan(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printSkillsHelp();
  const data = planSkills(ctx, { names: positionals });
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 shared skills plan");
  keyValue("Source", data.sourceRoot);
  keyValue("Target", data.skillsDir);
  keyValue("Selected", data.selected.length === 0 ? "all changed skills" : data.selected.join(", "));
  keyValue("Missing", data.actions.filter((item) => item.action === "copy-missing").length);
  keyValue("Conflicts", data.actions.filter((item) => item.action === "preserve-conflict").length);
  for (const action of data.actions) {
    const command = action.conflict
      ? `inspect: pi-67 skills diff ${action.name}; explicit sync: pi-67 skills sync ${action.name} --dry-run`
      : `sync: pi-67 skills sync ${action.name}`;
    info(`${action.name}: ${action.action}; ${command}`);
  }
  if (data.actions.length === 0) pass("no shared skill action is required");
}

function diff(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printSkillsHelp();
  const name = positionals[0];
  if (!name) throw new CliError("skills diff requires a skill name", 2);
  const data = diffSkill(ctx, name);
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 shared skill diff: ${name}`);
  keyValue("Source", data.source);
  keyValue("Target", data.target);
  keyValue("Target exists", data.targetExists ? "yes" : "no");
  keyValue("Identical", data.identical ? "yes" : "no");
  keyValue("Added files", data.diff.added.length);
  keyValue("Removed files", data.diff.removed.length);
  keyValue("Modified files", data.diff.modified.length);
  for (const file of data.diff.added.slice(0, 20)) info(`added in source: ${file}`);
  for (const file of data.diff.removed.slice(0, 20)) warn(`missing from source: ${file}`);
  for (const file of data.diff.modified.slice(0, 20)) info(`modified: ${file}`);
  const omitted = data.diff.added.length + data.diff.removed.length + data.diff.modified.length - 60;
  if (omitted > 0) warn(`${omitted} additional file diffs omitted; rerun with --json for full metadata`);
}

function sync(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run", "yes"] });
  if (options.help) return printSkillsHelp();
  const data = syncSkills(ctx, {
    dryRun: ctx.dryRun || options.dryRun,
    names: positionals,
    yes: ctx.yes || options.yes,
  });
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 shared skills sync");
  for (const action of data.actions) {
    if (action.action === "warn") warn(`${action.name}: ${action.reason}`);
    else info(`${action.name}: ${action.action}`);
  }
}

function migrate(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["dry-run", "json"] });
  if (options.help) return printSkillsHelp();
  const data = syncSkills(ctx, { dryRun: true });
  data.schema = "pi67.skills-migrate-preview.v1";
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 skills migrate preview");
  warn("migrate is intentionally dry-run in the npm manager; use `pi-67 skills sync` to copy missing skills.");
  keyValue("Missing", data.summary.missing);
  keyValue("Conflicts", data.summary.conflicts);
}

function printSkillsHelp() {
  process.stdout.write(`pi-67 skills - inspect and safely sync shared skills

Usage:
  pi-67 skills inventory [--json]
  pi-67 skills plan [skill...] [--json]
  pi-67 skills diff <skill> [--json]
  pi-67 skills sync [skill...] [--dry-run] [--yes] [--json]
  pi-67 skills migrate [--dry-run] [--json]

Safety:
  Missing skills are copied by default. Existing different global skills are
  preserved unless you name the skill explicitly and pass --yes. Bulk conflict
  overwrite is intentionally blocked.

Examples:
  pi-67 skills inventory
  pi-67 skills plan
  pi-67 skills diff lark-doc
  pi-67 skills sync lark-doc --dry-run
  pi-67 skills sync lark-doc --yes
`);
}
