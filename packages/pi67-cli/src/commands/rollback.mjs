import { parseCommandOptions } from "../lib/args.mjs";
import { rollbackDistroRelease, rollbackRuntimeMigration } from "../lib/release-store.mjs";
import { beginWorkspaceOperation } from "../lib/workspace-operation-lock.mjs";
import { CliError, keyValue, printJson, section } from "../lib/output.mjs";

export function rollbackCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["check", "dry-run", "json", "yes", "migration"],
  });
  if (options.help) return printRollbackHelp();
  const dryRun = ctx.dryRun || options.dryRun || options.check;
  if (!dryRun && !(ctx.yes || options.yes)) {
    throw new CliError("pi-67 rollback changes active files; preview with `pi-67 rollback --check`, then confirm with `pi-67 rollback --yes`", 2);
  }
  const operation = beginWorkspaceOperation(ctx, {
    operation: options.migration ? "migration-rollback" : "release-rollback",
    dryRun,
  });
  let result;
  try {
    result = options.migration
      ? rollbackRuntimeMigration(ctx, { dryRun })
      : rollbackDistroRelease(ctx, { dryRun });
  } finally {
    operation.release();
  }
  if (ctx.json || options.json) return printJson(result);
  section(options.migration ? "pi-67 migration rollback" : "pi-67 release rollback");
  keyValue("Dry run", dryRun ? "yes" : "no");
  keyValue("Version", result.version || result.journal?.targetVersion || "legacy layout");
  keyValue("Agent dir", result.agentDir || ctx.agentDir);
}

function printRollbackHelp() {
  process.stdout.write(`pi-67 rollback - restore a previous immutable release or legacy layout

Usage:
  pi-67 rollback --check [--json]
  pi-67 rollback --yes
  pi-67 rollback --migration --check
  pi-67 rollback --migration --yes
`);
}
