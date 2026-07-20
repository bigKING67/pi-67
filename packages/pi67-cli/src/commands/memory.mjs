import { parseCommandOptions } from "../lib/args.mjs";
import {
  digestMemory,
  doctorMemory,
  embeddingKeyFromEnv,
  flushMemory,
  forgetMemory,
  initializeMemory,
  memoryStatus,
  resetMemory,
  restartMemoryService,
  setMemoryEnabled,
  startMemoryService,
  stopMemoryService,
  upgradeMemory,
} from "../lib/memory-runtime.mjs";
import { CliError, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function memoryCommand(ctx, argv) {
  const sub = argv[0] || "status";
  const rest = argv.slice(1);
  if (sub === "init") return await init(ctx, rest);
  if (sub === "status") return await status(ctx, rest);
  if (sub === "doctor") return await doctor(ctx, rest);
  if (sub === "start") return await start(ctx, rest);
  if (sub === "stop") return await stop(ctx, rest);
  if (sub === "restart") return await restart(ctx, rest);
  if (sub === "enable") return await enable(ctx, rest, true);
  if (sub === "disable") return await enable(ctx, rest, false);
  if (sub === "upgrade") return await upgrade(ctx, rest);
  if (sub === "flush") return await flush(ctx, rest);
  if (sub === "forget") return await forget(ctx, rest);
  if (sub === "digest") return await digest(ctx, rest);
  if (sub === "reset") return await reset(ctx, rest);
  if (sub === "help" || sub === "--help" || sub === "-h") return printMemoryHelp();
  throw new CliError(`unknown memory command: ${sub}`, 2);
}

async function init(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run", "no-prompt"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory init");
  const json = Boolean(ctx.json || options.json);
  const dryRun = Boolean(ctx.dryRun || options.dryRun);
  const envKey = embeddingKeyFromEnv();
  let embeddingApiKey = envKey.value;
  let keySource = envKey.source;
  if (!embeddingApiKey && !dryRun && !options.noPrompt) {
    embeddingApiKey = await readSecret("SiliconFlow API key for BAAI/bge-m3 (input hidden): ");
    keySource = embeddingApiKey ? "interactive prompt" : "";
  }
  if (!json) info(`${dryRun ? "Planning" : "Preparing"} private local Hy-Memory runtime...`);
  const result = await initializeMemory(ctx, { embeddingApiKey, dryRun });
  if (json) return printJson(result);
  section("Hy-Memory initialization");
  keyValue("Root", result.root);
  keyValue("SDK", result.sdkVersion || result.runtime?.sdkVersion);
  keyValue("LLM", "deepseek-v4-flash (Pi auth provider: deepseek)");
  keyValue("Embedding", "BAAI/bge-m3 (1024 dimensions)");
  if (keySource) keyValue("Embedding key", keySource);
  if (dryRun) warn("DRY-RUN: no runtime, config, secrets, service, or memory data was written.");
  else pass("Hy-Memory initialized and authenticated loopback service started");
}

async function status(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory status");
  const result = await memoryStatus(ctx);
  if (ctx.json || options.json) return printJson(result);
  printStatus(result);
}

async function doctor(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "deep"], strings: ["timeout-ms"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory doctor");
  const timeoutMs = positiveInteger(options.timeoutMs, "--timeout-ms", 30000);
  const result = await doctorMemory(ctx, { deep: options.deep, timeoutMs });
  if (ctx.json || options.json) return printJson(result);
  section(`Hy-Memory doctor${result.deep ? " (deep)" : ""}`);
  for (const check of result.checks) (check.ok ? pass : warn)(`${check.id}: ${check.message}`);
  keyValue("Ready", result.ready ? "yes" : "no");
  if (result.probe) keyValue("Vector dimensions", result.probe.vectorDimensions);
}

async function start(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory start");
  const result = await startMemoryService(ctx);
  return emitResult(ctx, options, "Hy-Memory service", result, result.started ? "started" : "already running");
}

async function stop(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory stop");
  const result = await stopMemoryService();
  return emitResult(ctx, options, "Hy-Memory service", result, result.stopped ? "stopped" : "not running");
}

async function restart(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory restart");
  const result = await restartMemoryService(ctx);
  return emitResult(ctx, options, "Hy-Memory service", result, "restarted");
}

async function enable(ctx, argv, enabled) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, enabled ? "memory enable" : "memory disable");
  const result = await setMemoryEnabled(enabled);
  return emitResult(ctx, options, "Hy-Memory", result, enabled ? "enabled" : "disabled");
}

async function upgrade(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run", "force"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory upgrade");
  const result = await upgradeMemory(ctx, { dryRun: ctx.dryRun || options.dryRun, force: options.force });
  return emitResult(ctx, options, "Hy-Memory runtime", result, result.dryRun ? "upgrade planned" : "upgraded");
}

async function flush(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory flush");
  const result = await flushMemory(ctx);
  return emitResult(ctx, options, "Hy-Memory outbox", result, result.success ? "flushed" : "flush incomplete");
}

async function forget(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "yes"] });
  if (options.help) return printMemoryHelp();
  if (positionals.length !== 1) throw new CliError("Usage: pi-67 memory forget <memory-id> --yes", 2);
  const result = await forgetMemory(ctx, positionals[0], { yes: Boolean(ctx.yes || options.yes) });
  return emitResult(ctx, options, "Hy-Memory", result, `deleted ${result.deleted_count ?? 0} memory item(s)`);
}

async function digest(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "yes"], strings: ["timeout-ms"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory digest");
  const timeoutMs = positiveInteger(options.timeoutMs, "--timeout-ms", 15 * 60_000);
  const result = await digestMemory(ctx, { yes: Boolean(ctx.yes || options.yes), timeoutMs });
  return emitResult(ctx, options, "Hy-Memory System 2", result, result.success === false ? "digest incomplete" : "digest completed");
}

async function reset(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "yes"] });
  if (options.help) return printMemoryHelp();
  rejectPositionals(positionals, "memory reset");
  const result = await resetMemory({ yes: Boolean(ctx.yes || options.yes) });
  return emitResult(ctx, options, "Hy-Memory", result, result.reset ? `reset; backup: ${result.backup}` : "not initialized");
}

function emitResult(ctx, options, label, value, message) {
  if (ctx.json || options.json) return printJson(value);
  section(label);
  pass(message);
}

function printStatus(result) {
  section("Hy-Memory status");
  keyValue("Initialized", result.initialized ? "yes" : "no");
  keyValue("Enabled", result.enabled ? "yes" : "no");
  keyValue("Service", result.running ? "running" : "stopped");
  keyValue("Root", result.root);
  keyValue("Outbox", `${result.outbox.pending} pending, ${result.outbox.processing} processing, ${result.outbox.deadLetter} dead-letter`);
  for (const check of result.checks) (check.ok ? pass : warn)(`${check.id}: ${check.message}`);
  for (const next of result.nextSteps) info(`Next: ${next}`);
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CliError("interactive secret input requires a TTY; set PI67_HY_MEMORY_EMBEDDING_API_KEY or use --no-prompt");
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
    const onError = (error) => finish(new CliError(`SiliconFlow API key input failed: ${error.message}`));
    const onEnd = () => finish(new CliError("SiliconFlow API key input ended before Enter was pressed"));
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new CliError("SiliconFlow API key input cancelled", 130));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0008" || character === "\u007f") value = value.slice(0, -1);
        else if (character >= " ") value += character;
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
      finish(new CliError(`could not enable hidden SiliconFlow API key input: ${error.message}`));
    }
  });
}

function rejectPositionals(positionals, command) {
  if (positionals.length > 0) throw new CliError(`${command} does not accept positional values`, 2);
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliError(`${name} must be a positive integer`, 2);
  return parsed;
}

function printMemoryHelp() {
  process.stdout.write(`Usage: pi-67 memory <command> [options]

Commands:
  init [--dry-run] [--no-prompt]  Create the private Python 3.11 runtime and local config
  status                          Show initialization, service, and outbox status
  doctor [--deep]                 Validate config/runtime; --deep probes BGE-M3 dimensions
  start|stop|restart              Manage the authenticated loopback service
  enable|disable                  Resume or pause automatic recall/capture
  upgrade [--dry-run] [--force]  Install the pinned SDK/wrapper while preserving data
  flush                           Process all pending settled-turn captures now
  forget <memory-id> --yes        Permanently delete one memory
  digest --yes                    Explicitly run non-idempotent Ultra/System 2 processing
  reset --yes                     Stop and move the entire local state to a timestamped backup

Options:
  --json                          Emit machine-readable JSON
  --timeout-ms N                  Override deep-probe/digest timeout where supported

Models:
  LLM                             DeepSeek deepseek-v4-flash
  Embedding                       SiliconFlow BAAI/bge-m3 (1024 local vector dimensions)

Secrets:
  DeepSeek is read dynamically from ~/.pi/agent/auth.json provider 'deepseek'.
  SiliconFlow is accepted through hidden input or PI67_HY_MEMORY_EMBEDDING_API_KEY.
  Secrets are stored outside the repository in ~/.hy-memory/pi67/secrets.json.

Examples:
  pi-67 memory init
  pi-67 memory doctor --deep
`);
}
