import { parseCommandOptions } from "../lib/args.mjs";
import {
  diffSkill,
  inventorySkillPacks,
  inventorySkills,
  planSkills,
  syncSkillPack,
  syncSkills,
} from "../lib/skill-policy.mjs";
import { CliError, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function skillsCommand(ctx, argv) {
  const [sub = "inventory", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printSkillsHelp();
    return;
  }
  if (sub === "inventory") return inventory(ctx, rest);
  if (sub === "packs") return packs(ctx, rest);
  if (sub === "plan") return plan(ctx, rest);
  if (sub === "diff") return diff(ctx, rest);
  if (sub === "sync") return sync(ctx, rest);
  if (sub === "sync-pack") return syncPack(ctx, rest);
  if (sub === "migrate") return migrate(ctx, rest);
  throw new CliError(`unknown skills command: ${sub}`, 2);
}

function packs(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printSkillsHelp();
  const data = inventorySkillPacks(ctx);
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 shared skill packs");
  if (data.packs.length === 0) {
    warn("no shared skill packs are registered");
    return;
  }
  for (const pack of data.packs) {
    const status = pack.consistent
      ? "consistent"
      : `missing=${pack.summary.missing}, conflicts=${pack.summary.conflicts}`;
    const sourceCommit = pack.provenance?.sourceCommit?.slice(0, 12) || "unknown";
    info(`${pack.name}@${pack.version}: ${status}; skills=${pack.summary.skills}; source=${sourceCommit}`);
  }
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
  keyValue("Preserved user-modified", preservedUserModified(data.summary));
  for (const entry of data.entries.filter((item) => !item.identical)) {
    const status = entry.conflict ? "preserved user-modified" : "missing";
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
  keyValue("Preserved user-modified", data.actions.filter((item) => item.action === "preserve-conflict").length);
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
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["json", "dry-run", "yes"],
  });
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
  for (const transaction of data.recoveredTransactions || []) {
    warn(`removed stale Skill transaction: ${transaction}`);
  }
}

function syncPack(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["json", "dry-run", "yes"],
  });
  if (options.help) return printSkillsHelp();
  const name = positionals[0];
  if (!name) throw new CliError("skills sync-pack requires a pack name", 2);
  const data = syncSkillPack(ctx, name, {
    dryRun: ctx.dryRun || options.dryRun,
    yes: ctx.yes || options.yes,
  });
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 shared skill pack sync: ${data.pack.name}@${data.pack.version}`);
  for (const action of data.actions) {
    if (action.action === "warn") warn(`${action.name}: ${action.reason}`);
    else info(`${action.name}: ${action.action}`);
  }
  for (const transaction of data.recoveredTransactions || []) {
    warn(`removed stale Skill transaction: ${transaction}`);
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
  keyValue("Preserved user-modified", preservedUserModified(data.summary));
}

function preservedUserModified(summary) {
  return summary?.preservedUserModified ?? summary?.conflicts ?? 0;
}

function printSkillsHelp() {
  process.stdout.write(`pi-67 skills - inspect and safely sync shared skills

Usage:
  pi-67 skills inventory [--json]
  pi-67 skills packs [--json]
  pi-67 skills plan [skill...] [--json]
  pi-67 skills diff <skill> [--json]
  pi-67 skills sync [skill...] [--dry-run] [--yes] [--json]
  pi-67 skills sync-pack <pack> [--dry-run] [--yes] [--json]
  pi-67 skills migrate [--dry-run] [--json]

Safety:
  Missing skills are copied by default. Existing different global skills are
  preserved as user-modified unless you name the skill explicitly and pass
  --yes. Bulk overwrite of preserved user-modified skills is intentionally
  blocked. Managed Skills are deployed transactionally from the Git-tracked
  source and do not create persistent content backups. To roll back, select or
  revert the desired Git commit/tag and run sync-pack again. Writing syncs are
  serialized by a state-scoped deploy lock; dry-runs remain lock-free.

Examples:
  pi-67 skills inventory
  pi-67 skills packs
  pi-67 skills plan
  pi-67 skills diff lark-doc
  pi-67 skills sync lark-doc --dry-run
  pi-67 skills sync lark-doc --yes
  pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
  pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
  pi-67 skills sync-pack ai-berkshire-investment-suite --dry-run
  pi-67 skills sync-pack ai-berkshire-investment-suite --yes
`);
}
