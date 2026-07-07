import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function doctorCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "quiet", "dry-run", "deep-mcp", "strict-shared-skills"],
    strings: ["mcp-timeout-ms"],
  });
  const args = isWindows()
    ? ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir]
    : ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (ctx.json || options.json) args.push(isWindows() ? "-Json" : "--json");
  if (options.quiet) args.push(isWindows() ? "-Quiet" : "--quiet");
  if (options.strictSharedSkills) args.push(isWindows() ? "-StrictSharedSkills" : "--strict-shared-skills");
  if (!isWindows() && options.deepMcp) args.push("--deep-mcp");
  if (!isWindows() && options.mcpTimeoutMs) args.push("--mcp-timeout-ms", options.mcpTimeoutMs);
  runDistroScript(ctx, { sh: "pi67-doctor.sh", ps1: "pi67-doctor.ps1" }, args, {
    dryRun: ctx.dryRun || options.dryRun,
  });
}
