import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function smokeCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["ci", "quick", "dry-run"],
  });
  if (options.help) {
    printSmokeHelp();
    return;
  }
  const args = [];
  if (isWindows()) {
    if (options.ci || options.quick) args.push("-Ci");
  } else if (options.ci || options.quick) {
    args.push("--ci");
  }
  runDistroScript(ctx, { sh: "pi67-smoke.sh", ps1: "pi67-smoke.ps1" }, args, {
    dryRun: ctx.dryRun || options.dryRun,
  });
}

function printSmokeHelp() {
  process.stdout.write(`pi-67 smoke - run repository smoke gates

Usage:
  pi-67 smoke [--ci|--quick] [--dry-run]

Options:
  --ci       Run the CI smoke profile.
  --quick    Alias for the CI smoke profile.
  --dry-run  Print the script invocation without running it.

Examples:
  pi-67 smoke
  pi-67 smoke --ci
`);
}
