#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--clean")) {
  const { stripSettingsRuntimeMarkerText } = await import("../lib/settings-runtime-clean.mjs");
  const input = fs.readFileSync(0, "utf8");
  process.stdout.write(stripSettingsRuntimeMarkerText(input));
  process.exit(0);
}

if (args.includes("--migrate")) {
  const { migrateSettingsRuntimeState } = await import("../lib/settings-runtime-state.mjs");
  const ctx = {
    agentDir: path.resolve(valueAfter("--agent-dir") || process.cwd()),
    repoRoot: path.resolve(valueAfter("--repo-root") || process.cwd()),
    stateDir: path.resolve(valueAfter("--state-dir") || path.join(os.homedir(), ".pi", "pi67")),
  };
  const result = migrateSettingsRuntimeState(ctx, {
    normalizeSettingsJson: args.includes("--normalize"),
    installGitFilter: args.includes("--install-git-filter"),
    dryRun: args.includes("--dry-run"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

process.stderr.write(`Usage:
  settings-runtime-state-filter.mjs --clean
  settings-runtime-state-filter.mjs --migrate --agent-dir DIR --repo-root DIR [--state-dir DIR] [--normalize] [--install-git-filter] [--json] [--dry-run]
`);
process.exit(2);

function valueAfter(name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function printHuman(result) {
  if (result.markerFound) {
    console.log(`PASS migrated settings.json lastChangelogVersion to ${result.statePath}`);
  } else {
    console.log("PASS settings.json runtime marker is already absent");
  }
  if (result.settingsCreatedFromTemplate) {
    console.log(`PASS created ignored settings.json from ${result.templatePath}`);
  }
  if (result.settingsNormalized) {
    console.log("PASS normalized settings.json runtime marker/line endings");
  }
  if (result.gitIndexRefreshed) {
    console.log("PASS refreshed settings.json Git index stat cache");
  }
  if (result.gitFilterInstalled) {
    console.log("PASS installed local git clean filter for settings.json runtime marker");
  }
  if (result.gitFilterRemoved) {
    console.log("PASS removed legacy settings.json git clean filter");
  }
  for (const item of result.skipped) {
    console.log(`INFO ${item}`);
  }
  for (const item of result.errors) {
    console.error(`FAIL ${item}`);
  }
}
