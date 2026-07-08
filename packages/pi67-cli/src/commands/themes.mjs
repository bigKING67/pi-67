import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { currentTheme, hasTheme, listThemes } from "../lib/theme-policy.mjs";
import { readJsonFileIfExists, writeJsonAtomic } from "../lib/config-json.mjs";
import { createRuntimeBackup } from "../lib/update-safety.mjs";
import { CliError, keyValue, printJson, section, pass, fail, info } from "../lib/output.mjs";

export async function themesCommand(ctx, argv) {
  const [sub = "current", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printThemesHelp();
    return;
  }
  if (sub === "current") return current(ctx, rest);
  if (sub === "list") return list(ctx, rest);
  if (sub === "doctor") return doctor(ctx, rest);
  if (sub === "set") return setTheme(ctx, rest);
  throw new CliError(`unknown themes command: ${sub}`, 2);
}

function current(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printThemesHelp();
  const value = currentTheme(ctx);
  const data = {
    schema: "pi67.theme-current.v1",
    theme: value,
    installed: value ? hasTheme(ctx, value) : false,
  };
  if (ctx.json || options.json) return printJson(data);
  keyValue("Current theme", value || "unset");
  keyValue("Installed", data.installed ? "yes" : "no");
}

function list(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printThemesHelp();
  const themes = listThemes(ctx);
  if (ctx.json || options.json) return printJson({ schema: "pi67.theme-list.v1", themes });
  section("Available themes");
  for (const theme of themes) info(theme);
}

function doctor(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printThemesHelp();
  const theme = currentTheme(ctx);
  const installed = theme ? hasTheme(ctx, theme) : false;
  const data = { schema: "pi67.theme-doctor.v1", theme, installed };
  if (ctx.json || options.json) return printJson(data);
  if (!theme) fail("settings.json theme field is unset");
  else if (installed) pass(`theme exists: ${theme}`);
  else fail(`theme is configured but missing from installed theme packages: ${theme}`);
}

function setTheme(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["force", "dry-run"] });
  if (options.help) return printThemesHelp();
  const name = positionals[0];
  if (!name) throw new CliError("themes set requires a theme name", 2);
  if (!options.force && !hasTheme(ctx, name)) {
    throw new CliError(`theme not installed: ${name}`);
  }
  const settingsFile = path.join(ctx.agentDir, "settings.json");
  const settings = readJsonFileIfExists(settingsFile) || {};
  const previous = settings.theme || "";
  if (previous === name) {
    pass(`theme already set: ${name}`);
    return;
  }
  settings.theme = name;
  if (ctx.dryRun || options.dryRun) {
    info(`DRY-RUN set theme ${previous || "unset"} -> ${name}`);
    return;
  }
  const backupDir = path.join(ctx.stateDir, "backups", `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}-themes-set`);
  createRuntimeBackup(ctx, backupDir, { operation: "themes-set" });
  writeJsonAtomic(settingsFile, settings);
  pass(`theme set: ${previous || "unset"} -> ${name}`);
  info(`Preserved runtime backup: ${backupDir}`);
}

function printThemesHelp() {
  process.stdout.write(`pi-67 themes - inspect and explicitly set themes

Usage:
  pi-67 themes current [--json]
  pi-67 themes list [--json]
  pi-67 themes doctor [--json]
  pi-67 themes set <name> [--force] [--dry-run]

Safety:
  Updates install theme assets but never change the selected theme. Only
  \`pi-67 themes set <name>\` changes settings.json, and it writes a runtime
  backup first unless --dry-run is used.

Examples:
  pi-67 themes current
  pi-67 themes list
  pi-67 themes set gruvbox-dark --dry-run
`);
}
