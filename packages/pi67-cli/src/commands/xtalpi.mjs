import { parseCommandOptions } from "../lib/args.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { scriptPath } from "../lib/paths.mjs";
import { isWindows, findPowerShell } from "../lib/platform.mjs";
import { CliError } from "../lib/output.mjs";

export async function xtalpiCommand(ctx, argv) {
  const [sub = "health", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printXtalpiHelp();
    return;
  }
  if (sub === "health") return health(ctx, rest);
  if (sub === "smoke") return smoke(ctx, rest);
  if (sub === "capability") return capability(ctx, rest);
  if (sub === "trend") return trend(ctx, rest);
  if (sub === "drift") return drift(ctx, rest);
  if (sub === "stress") return stress(ctx, rest);
  throw new CliError(`unknown xtalpi command: ${sub}`, 2);
}

function health(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["model", "provider", "timeout-ms", "attempts"],
    bools: ["dry-run", "json"],
  });
  if (options.help) return printXtalpiHelp();
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
  if (options.help) return printXtalpiHelp();
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
    bools: ["dry-run", "self-test", "json"],
  });
  if (options.help) return printXtalpiHelp();
  const args = [scriptPath(ctx, "pi67-xtalpi-provider-capability-probe.mjs"), "--agent-dir", ctx.agentDir];
  if (options.selfTest) args.push("--self-test");
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.timeoutMs) args.push("--timeout-ms", options.timeoutMs);
  runCommand("node", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function trend(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["limit", "profile", "out-dir"],
    bools: ["json", "dry-run"],
  });
  if (options.help) return printXtalpiHelp();
  const limit = options.limit || "3";
  const args = [scriptPath(ctx, "pi67-xtalpi-pi-tools-debug-summary.sh"), "--trend-gate", limit];
  if (options.profile) args.push("--profile", options.profile);
  else args.push("--profile", "full-suite-strict");
  if (ctx.json || options.json) args.push("--json");
  if (options.outDir) args.push(options.outDir);
  runCommand("bash", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function drift(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["limit", "run-kind", "out-dir"],
    bools: ["json", "dry-run"],
  });
  if (options.help) return printXtalpiHelp();
  const limit = options.limit || "10";
  const args = [scriptPath(ctx, "pi67-xtalpi-pi-tools-debug-summary.sh"), "--drift", limit];
  args.push("--run-kind", options.runKind || "full-suite");
  if (ctx.json || options.json) args.push("--json");
  if (options.outDir) args.push(options.outDir);
  runCommand("bash", args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun });
}

function stress(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["case", "profile"],
    bools: ["until-done", "dry-run"],
  });
  if (options.help) return printXtalpiHelp();
  const smokeCase = options.untilDone ? "until-done-continuation" : options.case;
  if (smokeCase) return smoke(ctx, ["--case", smokeCase, ...(options.dryRun ? ["--dry-run"] : [])]);
  return smoke(ctx, ["--profile", options.profile || "full-suite", ...(options.dryRun ? ["--dry-run"] : [])]);
}

function profileFromOptions(options) {
  if (options.profile) return options.profile;
  if (options.extensionLowRisk) return "extension-low-risk";
  if (options.extensionExpanded) return "extension-expanded";
  if (options.quick) return "quick";
  return "quick";
}

function printXtalpiHelp() {
  process.stdout.write(`pi-67 xtalpi - xtalpi health, smoke, and artifact helpers

Usage:
  pi-67 xtalpi health [--provider ID] [--model NAME] [--timeout-ms N] [--attempts N]
  pi-67 xtalpi smoke [--quick|--extension-low-risk|--extension-expanded|--profile NAME]
  pi-67 xtalpi smoke --case NAME
  pi-67 xtalpi capability [--self-test] [--provider ID] [--model NAME]
  pi-67 xtalpi trend [--limit N] [--profile NAME] [--json] [--out-dir DIR]
  pi-67 xtalpi drift [--limit N] [--run-kind LIST] [--json] [--out-dir DIR]
  pi-67 xtalpi stress --until-done

Notes:
  xtalpi-pi-tools treats xtalpi as plain chat-completions transport. Pi local
  code owns tool protocol parsing, validation, repair, retry classification,
  tool execution, and smoke gates.
  xtalpi drift defaults to --run-kind full-suite so targeted one-off smoke
  artifacts do not create expected case-set drift noise.

Examples:
  pi-67 xtalpi health
  pi-67 xtalpi smoke --quick
  pi-67 xtalpi smoke --case until-done-continuation
  pi-67 xtalpi trend --json
  pi-67 xtalpi drift --json
  pi-67 xtalpi stress --until-done
`);
}
