import { spawnSync } from "node:child_process";
import { CliError, info } from "./output.mjs";

export function runCommand(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  if (options.dryRun) {
    info(`DRY-RUN (${cwd}) ${[command, ...args].join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const { result } = spawnWithFallback(command, args, {
    cwd,
    stdio: options.stdio || "inherit",
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  if (result.error) {
    throw new CliError(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError(`${command} exited with ${result.status}`, result.status || 1);
  }
  return result;
}

export function captureCommand(command, args = [], options = {}) {
  const { result } = spawnWithFallback(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : "",
  };
}

export function commandCandidatesForPlatform(command, platform = process.platform) {
  if (platform === "win32" && command === "npm") {
    return ["npm", "npm.cmd"];
  }
  return [command];
}

function spawnWithFallback(command, args, options) {
  let lastResult;
  for (const candidate of commandCandidatesForPlatform(command)) {
    const result = spawnSync(candidate, args, options);
    lastResult = result;
    if (!isCommandNotFound(result)) return { command: candidate, result };
  }
  return { command, result: lastResult };
}

function isCommandNotFound(result) {
  return result?.error?.code === "ENOENT";
}
