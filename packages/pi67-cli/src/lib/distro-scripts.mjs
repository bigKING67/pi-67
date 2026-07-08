import fs from "node:fs";
import { scriptPath } from "./paths.mjs";
import { isWindows, findPowerShell } from "./platform.mjs";
import { runCommand } from "./shell-runner.mjs";
import { CliError } from "./output.mjs";

export function runDistroScript(ctx, names, args = [], options = {}) {
  const script = isWindows() ? names.ps1 : names.sh;
  const file = scriptPath(ctx, script);
  if (!fs.existsSync(file)) {
    throw new CliError(`missing pi-67 script: ${file}`);
  }
  if (isWindows()) {
    const pwsh = findPowerShell();
    if (!pwsh) throw new CliError("PowerShell executable not found");
    return runCommand(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
      cwd: ctx.repoRoot,
      dryRun: options.dryRun,
      env: options.env,
      stdio: options.stdio,
      timeoutMs: options.timeoutMs,
    });
  }
  return runCommand("bash", [file, ...args], {
    cwd: ctx.repoRoot,
    dryRun: options.dryRun,
    env: options.env,
    stdio: options.stdio,
    timeoutMs: options.timeoutMs,
  });
}
