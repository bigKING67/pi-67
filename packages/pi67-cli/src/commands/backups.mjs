import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import {
  inspectLegacyConflictBackup,
  inspectRuntimeBackup,
  listLegacyConflictBackups,
  listRuntimeBackups,
  restoreRuntimeBackup,
} from "../lib/update-safety.mjs";
import { CliError, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function backupsCommand(ctx, argv) {
  const subcommand = argv[0] || "list";
  if (subcommand === "list") return listCommand(ctx, argv.slice(1));
  if (subcommand === "inspect") return inspectCommand(ctx, argv.slice(1));
  if (subcommand === "restore") return restoreCommand(ctx, argv.slice(1));
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    printBackupsHelp();
    return;
  }
  throw new CliError(`unknown backups subcommand: ${subcommand}`, 2);
}

function listCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "include-legacy"],
  });
  const backups = listRuntimeBackups(ctx);
  const legacyConflictBackups = listLegacyConflictBackups(ctx);
  if (ctx.json || options.json) {
    printJson({
      schema: "pi67.backups-list.v1",
      createdAt: new Date().toISOString(),
      backups,
      legacyConflictBackups: options.includeLegacy ? legacyConflictBackups : undefined,
    });
    return;
  }
  section("pi-67 runtime backups");
  keyValue("Backups dir", `${ctx.stateDir}/backups`);
  if (backups.length === 0) {
    warn("no runtime backups found");
  } else {
    for (const item of backups) {
      info(`${item.id}: ${item.operation}; files=${item.fileCount}; created=${item.createdAt || "unknown"}`);
    }
  }
  if (legacyConflictBackups.length > 0) {
    section("Legacy conflict backups");
    keyValue("Backups dir", path.join(path.dirname(ctx.stateDir), "agent-backups"));
    if (!options.includeLegacy) {
      warn(`${legacyConflictBackups.length} legacy pre-update conflict backups found; rerun with --include-legacy to list them.`);
    } else {
      for (const item of legacyConflictBackups) {
        info(`${item.id}: ${item.operation}; files=${item.fileCount}; bytes=${item.totalBytes}; created=${item.createdAt || "unknown"}`);
      }
    }
  }
}

function inspectCommand(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["json", "legacy"],
  });
  const backup = options.legacy ? inspectLegacyConflictBackup(ctx, positionals[0]) : inspectRuntimeBackup(ctx, positionals[0]);
  if (ctx.json || options.json) {
    printJson({
      schema: options.legacy ? "pi67.legacy-conflict-backup-inspect.v1" : "pi67.backup-inspect.v1",
      createdAt: new Date().toISOString(),
      backup,
    });
    return;
  }
  section("pi-67 runtime backup");
  keyValue("ID", backup.id);
  keyValue("Path", backup.path);
  keyValue("Created", backup.createdAt || "unknown");
  keyValue("Operation", backup.operation);
  if (backup.reason) keyValue("Reason", backup.reason);
  keyValue("Files", `${backup.fileCount}${backup.preservedCount === undefined ? "" : ` present / ${backup.preservedCount} preserved slots`}`);
  for (const file of backup.files) {
    if (file.name) {
      info(`${file.name}${file.bytes === undefined ? "" : ` bytes=${file.bytes}`}`);
      continue;
    }
    if (file.exists === false) {
      info(`${file.path} missing-at-backup-time`);
    } else {
      info(`${file.path}${file.bytes === undefined ? "" : ` bytes=${file.bytes}`}${file.sha256 ? ` sha256=${file.sha256}` : ""}`);
    }
  }
}

function restoreCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["from"],
    bools: ["json", "dry-run", "yes"],
  });
  const dryRun = ctx.dryRun || options.dryRun;
  if (!options.from) {
    throw new CliError("backups restore requires --from <backup-id-or-path>", 2);
  }
  if (!dryRun && !(ctx.yes || options.yes)) {
    throw new CliError("backups restore overwrites runtime config; rerun with --yes or use --dry-run", 2);
  }
  const result = restoreRuntimeBackup(ctx, options.from, { dryRun });
  if (ctx.json || options.json) {
    printJson(result);
    return;
  }
  section("pi-67 runtime restore");
  keyValue("Source", result.backup.path);
  keyValue("Dry run", result.dryRun ? "yes" : "no");
  if (result.preRestoreBackupDir) {
    keyValue("Pre-restore backup", result.preRestoreBackupDir);
  }
  for (const item of result.restored) {
    pass(`${item.path} restored`);
  }
  for (const item of result.removed) {
    pass(`${item.path} removed (${item.reason})`);
  }
  for (const item of result.missing) {
    warn(`${item.path} missing from backup files: ${item.source}`);
  }
  for (const item of result.skipped) {
    warn(`${item.path} skipped: ${item.reason}`);
  }
}

function printBackupsHelp() {
  process.stdout.write(`pi-67 backups - inspect and restore preserved runtime backups

Usage:
  pi-67 backups list [--include-legacy] [--json]
  pi-67 backups inspect <backup-id-or-path> [--legacy] [--json]
  pi-67 backups restore --from <backup-id-or-path> [--dry-run] [--yes] [--json]

Examples:
  pi-67 backups list
  pi-67 backups list --include-legacy
  pi-67 backups inspect 20260707T120000Z-update
  pi-67 backups inspect pre-update-20260707-235901 --legacy
  pi-67 backups restore --from 20260707T120000Z-update --dry-run
  pi-67 backups restore --from 20260707T120000Z-update --yes
`);
}
