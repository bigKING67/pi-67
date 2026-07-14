import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
  if (subcommand === "prune") return pruneCommand(ctx, argv.slice(1));
  if (subcommand === "archive") return archiveCommand(ctx, argv.slice(1));
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
  if (options.help) return printBackupsHelp();
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
  if (options.help) return printBackupsHelp();
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
  if (options.help) return printBackupsHelp();
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

function pruneCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["keep-last", "older-than"],
    bools: ["json", "dry-run", "yes", "include-legacy"],
  });
  if (options.help) return printBackupsHelp();
  const dryRun = ctx.dryRun || options.dryRun;
  const plan = buildRetentionPlan(ctx, options);
  if (!dryRun && !(ctx.yes || options.yes)) {
    throw new CliError("backups prune deletes backup directories; rerun with --dry-run or --yes", 2);
  }
  if (!dryRun) {
    for (const item of plan.selected) {
      fs.rmSync(item.path, { recursive: true, force: true });
    }
  }
  const result = {
    schema: "pi67.backups-prune.v1",
    createdAt: new Date().toISOString(),
    dryRun,
    selector: plan.selector,
    selected: plan.selected,
    kept: plan.kept,
    deleted: dryRun ? [] : plan.selected,
  };
  if (ctx.json || options.json) return printJson(result);
  section("pi-67 backups prune");
  keyValue("Dry run", dryRun ? "yes" : "no");
  keyValue("Selected", result.selected.length);
  keyValue("Kept", result.kept.length);
  for (const item of result.selected) {
    warn(`${dryRun ? "would delete" : "deleted"} ${item.kind}: ${item.id}`);
  }
  if (result.selected.length === 0) pass("no backups matched the retention selector");
}

function archiveCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["keep-last", "older-than", "to"],
    bools: ["json", "dry-run", "yes", "include-legacy"],
  });
  if (options.help) return printBackupsHelp();
  const dryRun = ctx.dryRun || options.dryRun;
  const plan = buildRetentionPlan(ctx, options);
  const archiveRoot = path.resolve(expandTilde(options.to || path.join(ctx.stateDir, "backups-archive")));
  if (!dryRun && !(ctx.yes || options.yes)) {
    throw new CliError("backups archive moves backup directories; rerun with --dry-run or --yes", 2);
  }
  const archived = [];
  if (!dryRun) {
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    for (const item of plan.selected) {
      const targetRoot = path.join(archiveRoot, item.kind);
      fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
      const target = uniqueArchivePath(path.join(targetRoot, item.id));
      moveDirectorySync(item.path, target);
      archived.push({ ...item, archivedPath: target });
    }
  }
  const result = {
    schema: "pi67.backups-archive.v1",
    createdAt: new Date().toISOString(),
    dryRun,
    archiveRoot,
    selector: plan.selector,
    selected: plan.selected,
    kept: plan.kept,
    archived: dryRun ? [] : archived,
  };
  if (ctx.json || options.json) return printJson(result);
  section("pi-67 backups archive");
  keyValue("Dry run", dryRun ? "yes" : "no");
  keyValue("Archive root", archiveRoot);
  keyValue("Selected", result.selected.length);
  for (const item of result.selected) {
    info(`${dryRun ? "would archive" : "archived"} ${item.kind}: ${item.id}`);
  }
  if (result.selected.length === 0) pass("no backups matched the retention selector");
}

function buildRetentionPlan(ctx, options) {
  const keepLast = parseOptionalNonNegativeInt(options.keepLast, "--keep-last");
  const olderThanMs = parseDurationMs(options.olderThan, "--older-than");
  if (keepLast === undefined && olderThanMs === undefined) {
    throw new CliError("backups retention requires --keep-last N and/or --older-than Nd|Nh|Nm", 2);
  }
  const now = Date.now();
  const runtime = listRuntimeBackups(ctx).map((item) => ({ ...item, kind: "runtime" }));
  const legacy = options.includeLegacy
    ? listLegacyConflictBackups(ctx).map((item) => ({ ...item, kind: "legacy" }))
    : [];
  const all = [...runtime, ...legacy].sort((left, right) => backupTime(right) - backupTime(left));
  const rankByKind = new Map();
  const selected = [];
  const kept = [];
  for (const item of all) {
    const rank = rankByKind.get(item.kind) || 0;
    rankByKind.set(item.kind, rank + 1);
    const keptByCount = keepLast !== undefined && rank < keepLast;
    const oldEnough = olderThanMs === undefined || now - backupTime(item) >= olderThanMs;
    if (!keptByCount && oldEnough) selected.push(item);
    else kept.push(item);
  }
  return {
    selector: {
      keepLast: keepLast ?? null,
      olderThan: options.olderThan || "",
      includeLegacy: Boolean(options.includeLegacy),
    },
    selected,
    kept,
  };
}

function parseOptionalNonNegativeInt(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new CliError(`${name} must be a non-negative integer`, 2);
  }
  return number;
}

function parseDurationMs(value, name) {
  if (value === undefined) return undefined;
  const match = /^(\d+)(m|h|d)$/i.exec(String(value).trim());
  if (!match) throw new CliError(`${name} must look like 30d, 12h, or 90m`, 2);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "d" ? 24 * 60 * 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 60 * 1000;
  return amount * multiplier;
}

function backupTime(item) {
  const parsed = Date.parse(item.createdAt || "");
  if (Number.isFinite(parsed)) return parsed;
  try {
    return fs.statSync(item.path).mtimeMs;
  } catch {
    return 0;
  }
}

function uniqueArchivePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  for (let index = 1; index < 1000; index += 1) {
    const next = `${candidate}.${index}`;
    if (!fs.existsSync(next)) return next;
  }
  throw new CliError(`could not allocate archive path for ${candidate}`, 1);
}

function expandTilde(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function moveDirectorySync(source, target) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  fs.rmSync(source, { recursive: true, force: true });
}

function printBackupsHelp() {
  process.stdout.write(`pi-67 backups - inspect, restore, prune, and archive managed backups

Usage:
  pi-67 backups list [--include-legacy] [--json]
  pi-67 backups inspect <backup-id-or-path> [--legacy] [--json]
  pi-67 backups restore --from <backup-id-or-path> [--dry-run] [--yes] [--json]
  pi-67 backups prune --keep-last N [--older-than 30d] [--include-legacy] [--dry-run|--yes] [--json]
  pi-67 backups archive --keep-last N [--older-than 30d] [--to DIR] [--include-legacy] [--dry-run|--yes] [--json]

Examples:
  pi-67 backups list
  pi-67 backups list --include-legacy
  pi-67 backups inspect 20260707T120000Z-update
  pi-67 backups inspect pre-update-20260707-235901 --legacy
  pi-67 backups restore --from 20260707T120000Z-update --dry-run
  pi-67 backups restore --from 20260707T120000Z-update --yes
  pi-67 backups prune --keep-last 10 --dry-run
  pi-67 backups archive --keep-last 10 --older-than 30d --dry-run

Retention:
  --keep-last applies to repo-external runtime backups. Legacy backups are
  ignored unless --include-legacy is provided. prune/archive require --dry-run
  or --yes. Managed Skills are Git-backed deployments and are not stored here.
`);
}
