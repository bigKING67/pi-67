import { parseCommandOptions } from "../lib/args.mjs";
import { inventorySkills, syncSkills } from "../lib/skill-policy.mjs";
import { CliError, info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export async function skillsCommand(ctx, argv) {
  const [sub = "inventory", ...rest] = argv;
  if (sub === "inventory") return inventory(ctx, rest);
  if (sub === "sync") return sync(ctx, rest);
  if (sub === "migrate") return migrate(ctx, rest);
  throw new CliError(`unknown skills command: ${sub}`, 2);
}

function inventory(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
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

function sync(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json", "dry-run"] });
  const data = syncSkills(ctx, { dryRun: ctx.dryRun || options.dryRun });
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 shared skills sync");
  for (const action of data.actions) {
    if (action.action === "warn") warn(`${action.name}: ${action.reason}`);
    else info(`${action.name}: ${action.action}`);
  }
}

function migrate(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["dry-run", "json"] });
  const data = syncSkills(ctx, { dryRun: true });
  data.schema = "pi67.skills-migrate-preview.v1";
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 skills migrate preview");
  warn("migrate is intentionally dry-run in the npm manager; use `pi-67 skills sync` to copy missing skills.");
  keyValue("Missing", data.summary.missing);
  keyValue("Conflicts", data.summary.conflicts);
}
