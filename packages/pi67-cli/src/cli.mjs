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
import { externalCommand } from "./commands/external.mjs";
import { selfUpdateCommand } from "./commands/self-update.mjs";
import { publishCheckCommand } from "./commands/publish-check.mjs";
import { manifestCommand } from "./commands/manifest.mjs";

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
  external: externalCommand,
  "self-update": selfUpdateCommand,
  "publish-check": publishCheckCommand,
  manifest: manifestCommand,
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
  --agent-dir DIR      Pi agent checkout. Default: ~/.pi/agent
  --repo-root DIR      pi-67 repo root. Default: same as --agent-dir
  --skills-dir DIR     Shared skills root. Default: ~/.agents/skills
  --packages-dir DIR   External package root. Default: ~/.agents/packages
  --json               Emit JSON when the command supports it
  --dry-run            Print planned writes without changing files
  --no-remote          Skip remote network checks where supported
  --yes                Confirm explicit opt-in actions where supported
  -h, --help           Show help

Commands:
  install              Clone/install pi-67 safely
  update               Update pi-67; use --check for read-only plan
  doctor               Run readiness diagnostics
  smoke                Run repository smoke gates
  status               Read-only status summary
  report               Generate pi67-report.json
  version              Print manager and distro versions
  xtalpi               xtalpi health/smoke/capability helpers
  themes               current/list/doctor/set without update-time overwrite
  skills               inventory/sync/migrate shared skills
  external             list/install/update/doctor external repos
  self-update          Explicitly update the npm manager package
  publish-check        Verify npm publish readiness and trusted publishing
  manifest             Show managed package/config/theme ownership policy

Examples:
  pi-67 install
  pi-67 update
  pi-67 update --check
  pi-67 update --repair
  pi-67 self-update
  pi-67 publish-check
  pi-67 manifest
  pi-67 xtalpi smoke --quick
  pi-67 themes current
`);
}
