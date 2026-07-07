import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function smokeCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["ci", "quick", "dry-run"],
  });
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
