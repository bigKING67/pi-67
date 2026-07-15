import { parseCommandOptions } from "../lib/args.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { inspectManagerFreshness, managerFreshnessBlockReason } from "../lib/manager-freshness.mjs";
import { info, section, warn } from "../lib/output.mjs";
import { isWindows } from "../lib/platform.mjs";

export async function doctorCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "quiet", "dry-run", "deep-mcp", "no-pi-list", "no-skill-list", "strict-shared-skills"],
    strings: ["mcp-timeout-ms", "pi-list-timeout-seconds", "skill-list-timeout-seconds"],
  });
  if (options.help) {
    printDoctorHelp();
    return;
  }
  if (!(ctx.json || options.json) && !options.quiet) {
    const freshness = await inspectManagerFreshness(ctx, { noRemote: ctx.noRemote });
    if (freshness.blocking) {
      section("pi-67 manager preflight");
      warn(managerFreshnessBlockReason(freshness));
      info(`Run: ${freshness.updateCommand}`);
      info("Then rerun: pi-67 update");
    }
  }
  const args = isWindows()
    ? ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir]
    : ["--agent-dir", ctx.agentDir, "--repo-root", ctx.repoRoot, "--skills-dir", ctx.skillsDir];
  if (ctx.json || options.json) args.push(isWindows() ? "-Json" : "--json");
  if (options.quiet) args.push(isWindows() ? "-Quiet" : "--quiet");
  if (options.strictSharedSkills) args.push(isWindows() ? "-StrictSharedSkills" : "--strict-shared-skills");
  if (!isWindows() && options.deepMcp) args.push("--deep-mcp");
  if (!isWindows() && options.mcpTimeoutMs) args.push("--mcp-timeout-ms", options.mcpTimeoutMs);
  const noPiList = options.noPiList || options.noSkillList;
  const piListTimeoutSeconds = options.piListTimeoutSeconds || options.skillListTimeoutSeconds;
  if (isWindows() && !noPiList) args.push("-PiList");
  if (!isWindows() && noPiList) args.push("--no-pi-list");
  if (piListTimeoutSeconds) {
    args.push(isWindows() ? "-PiListTimeoutSeconds" : "--pi-list-timeout-seconds", piListTimeoutSeconds);
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
  --no-pi-list            Skip the non-interactive pi list --no-approve package probe.
  --pi-list-timeout-seconds N
                          Timeout for the package probe where enabled.
  --no-skill-list         Deprecated alias for --no-pi-list.
  --skill-list-timeout-seconds N
                          Deprecated alias for --pi-list-timeout-seconds.
  --strict-shared-skills  Treat preserved user-modified shared skills as blocking.
  --dry-run               Print the script invocation without running it.

Examples:
  pi-67 doctor
  pi-67 doctor --json
`);
}
