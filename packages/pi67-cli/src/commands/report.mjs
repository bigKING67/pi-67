import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function reportCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["dry-run", "no-doctor"],
    strings: ["operation", "output"],
  });
  if (options.help) {
    printReportHelp();
    return;
  }
  const args = isWindows()
    ? ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir]
    : ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (options.operation) args.push(isWindows() ? "-Operation" : "--operation", options.operation);
  if (options.output) args.push(isWindows() ? "-Output" : "--output", options.output);
  if (options.noDoctor) args.push(isWindows() ? "-NoDoctor" : "--no-doctor");
  if (ctx.dryRun || options.dryRun) args.push(isWindows() ? "-DryRun" : "--dry-run");
  runDistroScript(ctx, { sh: "pi67-report.sh", ps1: "pi67-report.ps1" }, args, {
    dryRun: false,
  });
}

function printReportHelp() {
  process.stdout.write(`pi-67 report - generate pi67-report.json

Usage:
  pi-67 report [--operation NAME] [--output FILE] [--no-doctor] [--dry-run]

Options:
  --operation NAME  Operation label to embed in the report.
  --output FILE     Output path. Defaults to the distro report location.
  --no-doctor       Skip doctor data collection where supported.
  --dry-run         Print the script invocation without running it.

Examples:
  pi-67 report
  pi-67 report --operation update
`);
}
