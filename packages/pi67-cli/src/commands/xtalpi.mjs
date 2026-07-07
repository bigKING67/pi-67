import { parseCommandOptions } from "../lib/args.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { scriptPath } from "../lib/paths.mjs";
import { isWindows, findPowerShell } from "../lib/platform.mjs";
import { CliError } from "../lib/output.mjs";

export async function xtalpiCommand(ctx, argv) {
  const [sub = "health", ...rest] = argv;
  if (sub === "health") return health(ctx, rest);
  if (sub === "smoke") return smoke(ctx, rest);
  if (sub === "capability") return capability(ctx, rest);
  throw new CliError(`unknown xtalpi command: ${sub}`, 2);
}

function health(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["model", "provider", "timeout-ms", "attempts"],
    bools: ["dry-run"],
  });
  const args = [scriptPath(ctx, "pi67-xtalpi-provider-health.mjs"), "--agent-dir", ctx.agentDir];
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.timeoutMs) args.push("--timeout-ms", options.timeoutMs);
  if (options.attempts) args.push("--attempts", options.attempts);
  runCommand("node", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function smoke(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["case", "profile"],
    bools: ["quick", "extension-low-risk", "extension-expanded", "self-test", "dry-run"],
  });
  if (isWindows()) {
    const pwsh = findPowerShell();
    if (!pwsh) throw new CliError("PowerShell executable not found");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath(ctx, "pi67-xtalpi-pi-tools-smoke.ps1")];
    if (options.selfTest) args.push("-SelfTest");
    else if (options.case) args.push("-Case", options.case);
    else args.push("-Profile", profileFromOptions(options));
    runCommand(pwsh, args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
    return;
  }
  const args = [scriptPath(ctx, "pi67-xtalpi-pi-tools-smoke.sh")];
  if (options.selfTest) args.push("--self-test");
  else if (options.case) args.push("--case", options.case);
  else args.push("--profile", profileFromOptions(options));
  runCommand("bash", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function capability(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["model", "provider", "timeout-ms"],
    bools: ["dry-run", "self-test"],
  });
  const args = [scriptPath(ctx, "pi67-xtalpi-provider-capability-probe.mjs"), "--agent-dir", ctx.agentDir];
  if (options.selfTest) args.push("--self-test");
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.timeoutMs) args.push("--timeout-ms", options.timeoutMs);
  runCommand("node", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function profileFromOptions(options) {
  if (options.profile) return options.profile;
  if (options.extensionLowRisk) return "extension-low-risk";
  if (options.extensionExpanded) return "extension-expanded";
  if (options.quick) return "quick";
  return "quick";
}
