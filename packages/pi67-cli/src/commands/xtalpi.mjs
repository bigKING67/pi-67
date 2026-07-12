import { parseCommandOptions } from "../lib/args.mjs";
import { captureCommand, runCommand } from "../lib/shell-runner.mjs";
import { scriptPath } from "../lib/paths.mjs";
import { isWindows, findPowerShell } from "../lib/platform.mjs";
import { CliError, info, pass, printJson, section, warn } from "../lib/output.mjs";
import { configureXtalpiModels } from "../lib/xtalpi-config.mjs";

export async function xtalpiCommand(ctx, argv) {
  const [sub = "health", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printXtalpiHelp();
    return;
  }
  if (sub === "configure") return configure(ctx, rest);
  if (sub === "health") return health(ctx, rest);
  if (sub === "smoke") return smoke(ctx, rest);
  if (sub === "capability") return capability(ctx, rest);
  if (sub === "trend") return trend(ctx, rest);
  if (sub === "drift") return drift(ctx, rest);
  if (sub === "stress") return stress(ctx, rest);
  if (sub === "run") return run(ctx, rest);
  throw new CliError(`unknown xtalpi command: ${sub}`, 2);
}

async function configure(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["dry-run", "verify", "no-prompt", "json"],
  });
  if (options.help) return printXtalpiHelp();
  if (positionals.length > 0) {
    throw new CliError(
      "xtalpi configure does not accept positional values; use the hidden prompt or a supported secret environment variable",
      2,
    );
  }

  try {
    const dryRun = Boolean(ctx.dryRun || options.dryRun);
    const json = Boolean(ctx.json || options.json);
    const envKey = xtalpiKeyFromEnv();
    const preview = configureXtalpiModels({
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      dryRun: true,
      allowMissingKey: true,
    });

    let apiKey = envKey.value;
    let keySource = envKey.source;
    if (!apiKey && !preview.configured && !dryRun && !options.noPrompt) {
      apiKey = await readSecret(
        "xtalpi API key for xtalpi-pi-tools (input hidden): ",
      );
      keySource = apiKey ? "interactive prompt" : "";
    }

    const result = configureXtalpiModels({
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      apiKey,
      dryRun,
      allowMissingKey: dryRun,
    });

    let verification = null;
    if (options.verify && !dryRun) {
      verification = verifyXtalpiConfiguration(ctx);
    }

    if (json) {
      printJson({
        schema: "pi67-xtalpi-config/v1",
        provider: result.provider,
        model: result.model,
        modelsFile: result.modelsFile,
        configured: result.configured,
        changed: result.changed,
        normalized: result.normalized,
        backupPath: result.backupPath,
        changes: result.changes,
        keySource: keySource || (result.configured ? "existing local config" : "not configured"),
        dryRun,
        verification,
      });
      return;
    }

    section("Xtalpi configuration");
    pass("xtalpi-pi-tools provider contract is canonical");
    if (dryRun && !apiKey && !preview.configured) {
      info("DRY-RUN would request the personal xtalpi API key through a hidden prompt.");
    }
    if (keySource) info(`API key source: ${keySource}`);
    for (const change of result.changes) {
      info(`${dryRun ? "DRY-RUN would" : "Applied"}: ${change}`);
    }
    if (result.backupPath) {
      warn(`Preserved the pre-normalization file at: ${result.backupPath}`);
    }
    if (result.changed) {
      pass(`${dryRun ? "configuration plan is valid for" : "updated"} ${result.modelsFile}`);
    } else {
      pass(`unchanged: ${result.modelsFile}`);
    }
    if (verification?.ok) {
      pass(`xtalpi provider health passed in ${verification.elapsedMs} ms`);
    } else if (dryRun && options.verify) {
      info("DRY-RUN skipped live provider verification.");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`xtalpi configure failed: ${compact(error?.message || error)}`);
  }
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

function verifyXtalpiConfiguration(ctx) {
  const result = captureCommand("node", [
    scriptPath(ctx, "pi67-xtalpi-provider-health.mjs"),
    "--agent-dir",
    ctx.agentDir,
    "--provider",
    "xtalpi-pi-tools",
    "--model",
    "deepseek-v4-pro",
    "--attempts",
    "2",
  ], {
    cwd: ctx.repoRoot,
    timeoutMs: 75000,
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    // The actionable error below includes only bounded, non-secret diagnostics.
  }
  if (!result.ok || payload?.ok !== true) {
    const detail = payload?.errorMessage || result.stderr || result.error || "provider health returned an invalid result";
    throw new CliError(`xtalpi configuration was written, but live verification failed: ${compact(detail)}`);
  }
  return {
    ok: true,
    schema: payload.schema,
    provider: payload.provider,
    model: payload.model,
    elapsedMs: payload.elapsedMs,
    attemptsUsed: payload.attemptsUsed,
  };
}

function xtalpiKeyFromEnv() {
  for (const name of [
    "PI67_XTALPI_PI_TOOLS_API_KEY",
    "PI67_XTALPI_TOOLS_API_KEY",
    "PI67_XTALPI_API_KEY",
  ]) {
    const value = String(process.env[name] || "").trim();
    if (value) return { value, source: name };
  }
  return { value: "", source: "" };
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CliError(
      "interactive secret input requires a TTY; set PI67_XTALPI_API_KEY or rerun without --no-prompt",
    );
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.removeListener("end", onEnd);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Ignore terminal teardown errors after input completes.
      }
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onError = (error) => finish(new CliError(`xtalpi API key input failed: ${error.message}`));
    const onEnd = () => finish(new CliError("xtalpi API key input ended before Enter was pressed"));
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new CliError("xtalpi API key input cancelled", 130));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    try {
      process.stderr.write(prompt);
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.on("error", onError);
      stdin.on("end", onEnd);
      stdin.setRawMode(true);
      stdin.resume();
    } catch (error) {
      finish(new CliError(`could not enable hidden xtalpi API key input: ${error.message}`));
    }
  });
}

function compact(value, max = 500) {
  let text = String(value || "");
  for (const name of [
    "PI67_XTALPI_PI_TOOLS_API_KEY",
    "PI67_XTALPI_TOOLS_API_KEY",
    "PI67_XTALPI_API_KEY",
  ]) {
    const secret = String(process.env[name] || "");
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(["']?apiKey["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
    strings: ["model", "provider", "timeout-ms", "json-action-runs", "output-file"],
    bools: ["dry-run", "self-test", "skip-native-probes", "json"],
  });
  if (options.help) return printXtalpiHelp();
  const args = [scriptPath(ctx, "pi67-xtalpi-provider-capability-probe.mjs"), "--agent-dir", ctx.agentDir];
  if (options.selfTest) args.push("--self-test");
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.timeoutMs) args.push("--timeout-ms", options.timeoutMs);
  if (options.jsonActionRuns) args.push("--json-action-runs", options.jsonActionRuns);
  if (options.skipNativeProbes) args.push("--skip-native-probes");
  if (options.outputFile) args.push("--output-file", options.outputFile);
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

function run(ctx, argv) {
  const passthroughIndex = argv.indexOf("--");
  const optionArgv = passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex);
  const passthrough = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
  const { options, positionals } = parseCommandOptions(optionArgv, {
    strings: ["model", "provider"],
    bools: ["dry-run", "no-passive-observational-memory"],
  });
  if (options.help) return printXtalpiHelp();
  const provider = options.provider || "xtalpi-pi-tools";
  const model = options.model || "deepseek-v4-pro";
  const piArgs = [...positionals, ...passthrough];
  const env = {};
  if (options.noPassiveObservationalMemory) {
    env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "false";
  }
  if (isWindows()) {
    const pwsh = findPowerShell();
    if (!pwsh) throw new CliError("PowerShell executable not found");
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath(ctx, "pi67-xtalpi-pi-tools.ps1"),
      "-Provider",
      provider,
      "-Model",
      model,
      ...piArgs,
    ];
    runCommand(pwsh, args, { cwd: ctx.repoRoot, dryRun: ctx.dryRun || options.dryRun, env });
    return;
  }
  runCommand("bash", [scriptPath(ctx, "pi67-xtalpi-pi-tools.sh"), ...piArgs], {
    cwd: ctx.repoRoot,
    dryRun: ctx.dryRun || options.dryRun,
    env: { PROVIDER: provider, MODEL: model, ...env },
  });
}

function profileFromOptions(options) {
  if (options.profile) return options.profile;
  if (options.extensionLowRisk) return "extension-low-risk";
  if (options.extensionExpanded) return "extension-expanded";
  if (options.quick) return "quick";
  return "quick";
}

function printXtalpiHelp() {
  process.stdout.write(`pi-67 xtalpi - configure, verify, diagnose, and smoke xtalpi-pi-tools

Usage:
  pi-67 xtalpi configure [--verify] [--no-prompt] [--dry-run] [--json]
  pi-67 xtalpi health [--provider ID] [--model NAME] [--timeout-ms N] [--attempts N]
  pi-67 xtalpi smoke [--quick|--extension-low-risk|--extension-expanded|--profile NAME]
  pi-67 xtalpi smoke --case NAME
  pi-67 xtalpi capability [--self-test] [--provider ID] [--model NAME] [--timeout-ms N]
                           [--json-action-runs N] [--skip-native-probes] [--output-file FILE]
  pi-67 xtalpi trend [--limit N] [--profile NAME] [--json] [--out-dir DIR]
  pi-67 xtalpi drift [--limit N] [--run-kind LIST] [--json] [--out-dir DIR]
  pi-67 xtalpi stress --until-done
  pi-67 xtalpi run [--provider ID] [--model NAME] [--no-passive-observational-memory] [-- <pi args>]

Notes:
  xtalpi configure writes the personal key only to ignored local models.json.
  It accepts PI67_XTALPI_API_KEY for automation and never accepts a plaintext
  key as a command-line option. Use --verify for a live provider health check.
  xtalpi-pi-tools treats xtalpi as plain chat-completions transport. Pi local
  code owns tool protocol parsing, validation, repair, retry classification,
  tool execution, and smoke gates.
  xtalpi run uses the stable launcher and defaults
  PI_OBSERVATIONAL_MEMORY_PASSIVE=true so post-final background memory writes
  cannot hold the main task lifecycle open. Pass --no-passive-observational-memory
  only when you explicitly want pi-observational-memory to record after final.
  xtalpi drift defaults to --run-kind full-suite so targeted one-off smoke
  artifacts do not create expected case-set drift noise.

Examples:
  pi-67 xtalpi configure --verify
  pi-67 xtalpi health
  pi-67 xtalpi smoke --quick
  pi-67 xtalpi smoke --case until-done-continuation
  pi-67 xtalpi trend --json
  pi-67 xtalpi drift --json
  pi-67 xtalpi stress --until-done
  pi-67 xtalpi run
`);
}
