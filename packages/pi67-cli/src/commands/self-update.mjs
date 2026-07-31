import { parseCommandOptions } from "../lib/args.mjs";
import { readCliPackageJson } from "../lib/paths.mjs";
import { runNetworkCommand } from "../lib/shell-runner.mjs";
import { CliError, info, pass } from "../lib/output.mjs";

export async function selfUpdateCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["dry-run"],
    strings: ["timeout-ms"],
  });
  if (options.help) {
    printSelfUpdateHelp();
    return;
  }
  const pkg = readCliPackageJson();
  const dryRun = ctx.dryRun || options.dryRun;
  const timeoutMs = positiveIntegerOrUndefined(options.timeoutMs, "--timeout-ms");
  runNetworkCommand("npm", ["install", "-g", `${pkg.name}@latest`], { dryRun, timeoutMs });
  if (dryRun) {
    info(`DRY-RUN would update ${pkg.name} globally via npm`);
    return;
  }
  pass(`${pkg.name} manager updated. Run \`pi-67 version\` in a new terminal to verify the active PATH entry.`);
}

function printSelfUpdateHelp() {
  process.stdout.write(`pi-67 self-update - update the npm manager package

Usage:
  pi-67 self-update [--dry-run] [--timeout-ms N]

Options:
  --dry-run      Print the npm install command without running it.
  --timeout-ms N Override the 600000ms network command timeout.

Examples:
  pi-67 self-update --dry-run
  pi-67 self-update
`);
}

function positiveIntegerOrUndefined(value, name) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError(`${name} must be an integer >= 1`, 2);
  return parsed;
}
