import { spawnSync } from "node:child_process";
import { CliError, info } from "./output.mjs";

export function runCommand(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  if (options.dryRun) {
    info(`DRY-RUN (${cwd}) ${[command, ...args].join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, {
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
  const result = spawnSync(command, args, {
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
