import { parseCommandOptions } from "../lib/args.mjs";
import { readCliPackageJson } from "../lib/paths.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { info, pass } from "../lib/output.mjs";

export async function selfUpdateCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["dry-run"] });
  if (options.help) {
    printSelfUpdateHelp();
    return;
  }
  const pkg = readCliPackageJson();
  const dryRun = ctx.dryRun || options.dryRun;
  runCommand("npm", ["install", "-g", `${pkg.name}@latest`], { dryRun });
  if (dryRun) {
    info(`DRY-RUN would update ${pkg.name} globally via npm`);
    return;
  }
  pass(`${pkg.name} manager updated. Run \`pi-67 version\` to verify the active PATH entry.`);
}

function printSelfUpdateHelp() {
  process.stdout.write(`pi-67 self-update - update the npm manager package

Usage:
  pi-67 self-update [--dry-run]

Options:
  --dry-run  Print the npm install command without running it.

Examples:
  pi-67 self-update --dry-run
  pi-67 self-update
`);
}
