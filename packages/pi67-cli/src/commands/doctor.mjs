import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function doctorCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "quiet", "dry-run", "deep-mcp", "no-skill-list", "strict-shared-skills"],
    strings: ["mcp-timeout-ms", "skill-list-timeout-seconds"],
  });
  if (options.help) {
    printDoctorHelp();
    return;
  }
  const args = isWindows()
    ? ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir]
    : ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (ctx.json || options.json) args.push(isWindows() ? "-Json" : "--json");
  if (options.quiet) args.push(isWindows() ? "-Quiet" : "--quiet");
  if (options.strictSharedSkills) args.push(isWindows() ? "-StrictSharedSkills" : "--strict-shared-skills");
  if (!isWindows() && options.deepMcp) args.push("--deep-mcp");
  if (!isWindows() && options.mcpTimeoutMs) args.push("--mcp-timeout-ms", options.mcpTimeoutMs);
  if (!isWindows() && options.noSkillList) args.push("--no-skill-list");
  if (options.skillListTimeoutSeconds) {
    args.push(isWindows() ? "-SkillListTimeoutSeconds" : "--skill-list-timeout-seconds", options.skillListTimeoutSeconds);
  }
  runDistroScript(ctx, { sh: "pi67-doctor.sh", ps1: "pi67-doctor.ps1" }, args, {
    dryRun: ctx.dryRun || options.dryRun,
  });
}

function printDoctorHelp() {
  process.stdout.write(`pi-67 doctor - run readiness diagnostics

Usage:
  pi-67 doctor [--json] [--quiet] [--deep-mcp] [--strict-shared-skills]

Options:
  --json                  Emit machine-readable diagnostics.
  --quiet                 Reduce human output where supported.
  --deep-mcp              Run deeper MCP probes on POSIX platforms.
  --mcp-timeout-ms N      Timeout for deep MCP probes on POSIX platforms.
  --no-skill-list         Skip pi skill list on POSIX platforms; accepted as a no-op on Windows.
  --skill-list-timeout-seconds N
                          Timeout for pi skill list where enabled.
  --strict-shared-skills  Treat differing shared skills as blocking.
  --dry-run               Print the script invocation without running it.

Examples:
  pi-67 doctor
  pi-67 doctor --json
`);
}
