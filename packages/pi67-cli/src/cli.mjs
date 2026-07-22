import { splitGlobalArgs } from "./lib/args.mjs";
import { resolveContext } from "./lib/paths.mjs";
import { CliError } from "./lib/output.mjs";
import { installCommand } from "./commands/install.mjs";
import { updateCommand } from "./commands/update.mjs";
import { doctorCommand } from "./commands/doctor.mjs";
import { smokeCommand } from "./commands/smoke.mjs";
import { statusCommand } from "./commands/status.mjs";
import { reportCommand } from "./commands/report.mjs";
import { versionCommand } from "./commands/version.mjs";
import { xtalpiCommand } from "./commands/xtalpi.mjs";
import { themesCommand } from "./commands/themes.mjs";
import { skillsCommand } from "./commands/skills.mjs";
import { extensionsCommand } from "./commands/extensions.mjs";
import { externalCommand } from "./commands/external.mjs";
import { selfUpdateCommand } from "./commands/self-update.mjs";
import { publishCheckCommand } from "./commands/publish-check.mjs";
import { manifestCommand } from "./commands/manifest.mjs";
import { backupsCommand } from "./commands/backups.mjs";
import { launchCommand } from "./commands/launch.mjs";
import { memoryCommand } from "./commands/memory.mjs";
import { migrateCommand } from "./commands/migrate.mjs";
import { rollbackCommand } from "./commands/rollback.mjs";

const COMMANDS = {
  install: installCommand,
  update: updateCommand,
  doctor: doctorCommand,
  smoke: smokeCommand,
  status: statusCommand,
  report: reportCommand,
  version: versionCommand,
  xtalpi: xtalpiCommand,
  themes: themesCommand,
  skills: skillsCommand,
  extensions: extensionsCommand,
  external: externalCommand,
  "self-update": selfUpdateCommand,
  "publish-check": publishCheckCommand,
  manifest: manifestCommand,
  backups: backupsCommand,
  launch: launchCommand,
  memory: memoryCommand,
  migrate: migrateCommand,
  rollback: rollbackCommand,
};

export async function main(argv) {
  const { globals, rest } = splitGlobalArgs(argv);
  if (globals.help || rest.length === 0 || rest[0] === "help") {
    printHelp();
    return;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    await versionCommand(resolveContext(globals), []);
    return;
  }
  const command = rest[0];
  const handler = COMMANDS[command];
  if (!handler) {
    throw new CliError(`unknown command: ${command}`, 2);
  }
  const ctx = resolveContext(globals);
  await handler(ctx, rest.slice(1));
}

function printHelp() {
  process.stdout.write(`pi-67 - pi-67 distribution manager

Usage:
  pi-67 [global options] <command> [options]

Global options:
  --agent-dir DIR      Active Pi workspace. Default: ~/.pi/agent
  --repo-root DIR      Distro source override for maintainers. Default: --agent-dir
  --skills-dir DIR     Shared skills root. Default: ~/.agents/skills
  --packages-dir DIR   External package root. Default: ~/.agents/packages
  --json               Emit JSON when the command supports it
  --dry-run            Print planned writes without changing files
  --no-remote          Skip remote network checks where supported
  --yes                Confirm explicit opt-in actions where supported
  -h, --help           Show help

Commands:
  install              Install the manager-bundled pi-67 distro safely
  update               Update pi-67; use --check for read-only plan
  doctor               Run readiness diagnostics
  smoke                Run repository smoke gates
  status               Read-only status summary
  report               Generate pi67-report.json
  version              Print manager and distro versions
  xtalpi               Configure and verify the company xtalpi-pi-tools provider
  themes               current/list/doctor/set without update-time overwrite
  skills               inventory/packs/plan/diff/transactional sync governance
  extensions           list/doctor/inspect/plan extension ownership policy
  external             list/install/setup/update/doctor external repos
  self-update          Explicitly update the npm manager package
  publish-check        Verify npm publish readiness and trusted publishing
  manifest             Show managed package/config/theme ownership policy
  backups              list/inspect/restore/prune/archive runtime backups
  launch               Optional Windows PATH compatibility wrapper for pi
  memory               Initialize and manage private local Hy-Memory recall/capture
  migrate              Move a legacy Git checkout to immutable releases
  rollback             Restore the previous release or legacy layout

Examples:
  pi-67 install
  pi-67 update
  pi-67 update --check
  pi-67 update --repair
  pi-67 self-update
  pi-67 publish-check
  pi-67 manifest
  pi-67 manifest --validate
  pi-67 backups list
  pi-67 backups prune --keep-last 10 --dry-run
  pi-67 extensions doctor
  pi-67 external install browser67 --dry-run
  pi-67 external doctor browser67 --deep
  pi-67 skills plan
  pi-67 xtalpi configure --verify
  pi-67 xtalpi smoke --quick
  pi-67 xtalpi trend
  pi-67 themes current
  pi-67 memory init
  pi-67 memory doctor --deep
`);
}
