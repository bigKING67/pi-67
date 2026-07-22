import fs from "node:fs";
import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";
import { printJson } from "../lib/output.mjs";

export async function reportCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "dry-run", "no-doctor"],
    strings: ["operation", "output"],
  });
  if (options.help) {
    printReportHelp();
    return;
  }
  const args = isWindows()
    ? [
        "-AgentDir", ctx.agentDir,
        "-StateDir", ctx.stateDir,
        "-RepoRoot", ctx.repoRoot,
        "-SkillsDir", ctx.skillsDir,
      ]
    : [
        "--agent-dir", ctx.agentDir,
        "--state-dir", ctx.stateDir,
        "--repo-root", ctx.repoRoot,
        "--skills-dir", ctx.skillsDir,
      ];
  if (options.operation) args.push(isWindows() ? "-Operation" : "--operation", options.operation);
  const outputPath = options.output || path.join(ctx.agentDir, "pi67-report.json");
  const resolvedOutputPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.repoRoot, outputPath);
  args.push(isWindows() ? "-Output" : "--output", outputPath);
  if (options.noDoctor) args.push(isWindows() ? "-NoDoctor" : "--no-doctor");
  if (ctx.dryRun || options.dryRun) args.push(isWindows() ? "-DryRun" : "--dry-run");
  const json = ctx.json || options.json;
  if (json && (ctx.dryRun || options.dryRun)) {
    printJson({
      schema: "pi67.report-command.v1",
      dryRun: true,
      output: resolvedOutputPath,
      stateDir: ctx.stateDir,
      operation: options.operation || "manual",
      doctor: options.noDoctor ? "skipped" : "enabled",
    });
    return;
  }
  runDistroScript(ctx, { sh: "pi67-report.sh", ps1: "pi67-report.ps1" }, args, {
    dryRun: false,
    stdio: json ? "pipe" : "inherit",
  });
  if (json) {
    process.stdout.write(fs.readFileSync(resolvedOutputPath, "utf8"));
  }
}

function printReportHelp() {
  process.stdout.write(`pi-67 report - generate pi67-report.json

Usage:
  pi-67 report [--json] [--operation NAME] [--output FILE] [--no-doctor] [--dry-run]

Options:
  --json           Emit the generated report JSON to stdout.
  --operation NAME  Operation label to embed in the report.
  --output FILE     Output path. Defaults to the distro report location.
  --no-doctor       Skip doctor data collection where supported.
  --dry-run         Print the script invocation without running it.

Examples:
  pi-67 report
  pi-67 report --operation update
`);
}
