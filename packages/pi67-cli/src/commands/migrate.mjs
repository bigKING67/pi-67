import { parseCommandOptions } from "../lib/args.mjs";
import { applyManagedExtensionBaselines } from "../lib/managed-extensions.mjs";
import {
  inspectRuntimeMigration,
  migrateRuntimeLayout,
  currentReleasePath,
  resolveDistroSourceRoot,
} from "../lib/release-store.mjs";
import { syncSkills } from "../lib/skill-policy.mjs";
import { migrateSettingsRuntimeState } from "../lib/settings-runtime-state.mjs";
import { CliError, info, keyValue, printJson, section } from "../lib/output.mjs";

export function migrateCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["check", "dry-run", "json", "yes", "no-npm"],
  });
  if (options.help) return printMigrateHelp();
  const dryRun = ctx.dryRun || options.dryRun || options.check;
  const json = ctx.json || options.json;
  const sourceRoot = resolveDistroSourceRoot(ctx);
  if (dryRun) {
    const result = inspectRuntimeMigration(ctx, { sourceRoot });
    if (json) return printJson(result);
    printMigration(result);
    return;
  }
  if (!(ctx.yes || options.yes)) {
    throw new CliError("pi-67 migrate changes the runtime layout; preview with `pi-67 migrate --check`, then confirm with `pi-67 migrate --yes`", 2);
  }
  const migration = migrateRuntimeLayout(ctx, { sourceRoot });
  const activeSource = currentReleasePath(ctx) || sourceRoot;
  const extensionResult = applyManagedExtensionBaselines(ctx, {
    sourceRoot: activeSource,
    skipNpm: options.noNpm,
  });
  const skills = syncSkills({ ...ctx, repoRoot: activeSource });
  const runtimeState = migrateSettingsRuntimeState(ctx, {
    normalizeSettingsJson: true,
    installGitFilter: false,
  });
  const result = {
    schema: "pi67.migrate.v1",
    createdAt: new Date().toISOString(),
    migration,
    extensions: extensionResult,
    skills: { summary: skills.summary, actions: skills.actions },
    runtimeState,
  };
  if (json) return printJson(result);
  section("pi-67 runtime migration");
  keyValue("Status", migration.status);
  keyValue("Target version", migration.targetVersion || "unknown");
  keyValue("Extension actions", extensionResult.applied.length);
  keyValue("Missing Skills copied", skills.actions.filter((item) => item.action === "copy").length);
  info("User provider, model, theme, auth, MCP, sessions, Git extensions, npm extensions, and modified Skills were preserved.");
}

function printMigration(result) {
  section("pi-67 migration check");
  keyValue("Agent dir", result.agentDir);
  keyValue("State dir", result.stateDir);
  keyValue("Target version", result.targetVersion);
  keyValue("Legacy Git checkout", result.legacyGitCheckout ? "yes" : "no");
  keyValue("Migration required", result.required ? "yes" : "no");
  keyValue("Preserves", result.preserves.join(", "));
}

function printMigrateHelp() {
  process.stdout.write(`pi-67 migrate - move a legacy Git checkout to the immutable release layout

Usage:
  pi-67 migrate --check [--json]
  pi-67 migrate --yes [--no-npm]

The migration keeps the original checkout under the active workspace stateDir,
activates the manager's bundled distro, and preserves user runtime files,
sessions, npm extensions, Git extensions, unknown extensions, MCP configuration,
and Skills.
`);
}
