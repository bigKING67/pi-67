import fs from "node:fs";
import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { applyManagedExtensionBaselines } from "../lib/managed-extensions.mjs";
import {
  activateDistroRelease,
  readCurrentRelease,
  resolveDistroSourceRoot,
} from "../lib/release-store.mjs";
import { syncSkills } from "../lib/skill-policy.mjs";
import { migrateSettingsRuntimeState } from "../lib/settings-runtime-state.mjs";
import { writeState } from "../lib/state-store.mjs";
import { CliError, info, keyValue, printJson, section } from "../lib/output.mjs";

export function installCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["dry-run", "json", "repair", "no-npm"],
  });
  if (options.help) return printInstallHelp();
  const dryRun = ctx.dryRun || options.dryRun;
  const json = ctx.json || options.json;
  const sourceRoot = resolveDistroSourceRoot(ctx);
  const legacyCheckout = fs.existsSync(path.join(ctx.agentDir, ".git"));
  const current = readCurrentRelease(ctx);
  const nonEmptyUnmanaged = isNonEmptyDirectory(ctx.agentDir) && !current;
  if ((legacyCheckout || nonEmptyUnmanaged) && !options.repair) {
    throw new CliError([
      `existing Pi agent runtime needs an explicit layout migration: ${ctx.agentDir}`,
      "Preview: pi-67 migrate --check",
      "Apply:   pi-67 migrate --yes",
      "The migration preserves personal MCP, provider/model/theme/auth state, sessions, extensions, and Skills.",
    ].join("\n"), 2);
  }
  if ((legacyCheckout || nonEmptyUnmanaged) && options.repair) {
    throw new CliError("`pi-67 install --repair` does not replace a legacy/unmanaged agent directory; run `pi-67 migrate --check` first", 2);
  }

  const activation = activateDistroRelease(ctx, {
    sourceRoot,
    dryRun,
    operation: options.repair ? "install-repair" : "install",
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
  if (!dryRun) writeState(ctx, options.repair ? "install-repair" : "install");

  const result = {
    schema: "pi67.install.v1",
    createdAt: new Date().toISOString(),
    dryRun,
    activation,
    extensions,
    skills: { summary: skills.summary, actions: skills.actions },
    runtimeState,
  };
  if (json) return printJson(result);
  section("pi-67 install");
  keyValue("Distro", activation.version);
  keyValue("Immutable release", activation.releasePath);
  keyValue("Extension actions", extensions.applied.length);
  keyValue("Preserved extension conflicts", extensions.before.summary.userManagedDiverged);
  keyValue("Missing Skills copied", skills.actions.filter((item) => ["copy", "copy-dry-run"].includes(item.action)).length);
  info(dryRun ? "Dry run completed; no files were changed." : "Install finished. Run `pi-67 doctor` next.");
}

function isNonEmptyDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function printInstallHelp() {
  process.stdout.write(`pi-67 install - install the manager-bundled distro safely

Usage:
  pi-67 install [--dry-run] [--json] [--no-npm]
  pi-67 install --repair [--dry-run]

Install activates an immutable distro bundled with this exact pi-67 manager.
It never clones GitHub main and never installs or updates the Pi runtime.
Existing legacy Git checkouts must use pi-67 migrate --check / --yes.
Default extensions use minimum baselines: missing and safe-behind copies update,
newer and user-modified copies are preserved. Unknown extensions are untouched.
`);
}
