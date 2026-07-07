import { parseCommandOptions } from "../lib/args.mjs";
import { EXTERNAL_REPOS, externalStatus, installExternal, listExternal, updateExternal } from "../lib/external-repos.mjs";
import { CliError, info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export async function externalCommand(ctx, argv) {
  const [sub = "list", ...rest] = argv;
  if (sub === "list") return list(ctx, rest);
  if (sub === "install") return install(ctx, rest);
  if (sub === "update") return update(ctx, rest);
  if (sub === "doctor") return doctor(ctx, rest);
  throw new CliError(`unknown external command: ${sub}`, 2);
}

function list(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  const data = { schema: "pi67.external-list.v1", repos: listExternal(ctx) };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 external repos");
  for (const repo of data.repos) {
    keyValue(repo.name, repo.exists ? `${repo.path} ${repo.git?.dirty ? "dirty" : "clean"}` : `missing at ${repo.path}`);
  }
}

function install(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run"] });
  const name = positionals[0];
  assertExternalName(name);
  const data = installExternal(ctx, name, { dryRun: ctx.dryRun || options.dryRun });
  if (ctx.json || options.json) return printJson(data);
  info(`${name}: ${data.action}`);
}

function update(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run"] });
  const name = positionals[0];
  assertExternalName(name);
  const data = updateExternal(ctx, name, { dryRun: ctx.dryRun || options.dryRun });
  if (ctx.json || options.json) return printJson(data);
  info(`${name}: ${data.action}`);
}

function doctor(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  const name = positionals[0];
  assertExternalName(name);
  const data = externalStatus(ctx, name);
  if (ctx.json || options.json) return printJson(data);
  section(`external doctor: ${name}`);
  keyValue("Path", data.path);
  keyValue("Exists", data.exists ? "yes" : "no");
  if (!data.exists) {
    warn(`Run: pi-67 external install ${name}`);
    return;
  }
  keyValue("Git", data.git?.isRepo ? "yes" : "no");
  keyValue("Dirty", data.git?.dirty ? "yes" : "no");
  keyValue("Commit", data.git?.commit || "");
}

function assertExternalName(name) {
  if (!name) throw new CliError(`external repo name required. Available: ${Object.keys(EXTERNAL_REPOS).join(", ")}`, 2);
  if (!EXTERNAL_REPOS[name]) throw new CliError(`unknown external repo: ${name}`, 2);
}
