import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function reportCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["dry-run", "no-doctor"],
    strings: ["operation", "output"],
  });
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
