import os from "node:os";
import { spawnSync } from "node:child_process";

export function isWindows() {
  return process.platform === "win32";
}

export function platformName() {
  return `${process.platform}-${os.arch()}`;
}

export function commandExists(name) {
  const result = isWindows()
    ? spawnSync("where.exe", [name], { encoding: "utf8" })
    : spawnSync("sh", ["-lc", `command -v ${shellQuote(name)}`], { encoding: "utf8" });
  return result.status === 0;
}

export function findPowerShell() {
  if (commandExists("pwsh")) return "pwsh";
  if (commandExists("powershell")) return "powershell";
  return "";
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
