import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliError, info } from "./output.mjs";

export function runCommand(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  if (options.dryRun) {
    info(`DRY-RUN (${cwd}) ${[command, ...args].join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const env = envWithWindowsGitFallback({ ...process.env, ...(options.env || {}) });
  const { result } = spawnWithFallback(command, args, {
    cwd,
    stdio: options.stdio || "inherit",
    env,
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
  const env = envWithWindowsGitFallback({ ...process.env, ...(options.env || {}) });
  const { result } = spawnWithFallback(command, args, {
    cwd: options.cwd || process.cwd(),
    env,
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

export function commandCandidatesForPlatform(command, platform = process.platform, env = process.env) {
  if (platform === "win32" && command === "npm") {
    return ["npm", "npm.cmd", "cmd.exe"];
  }
  if (platform === "win32" && command === "git") {
    return dedupe(["git", "git.exe", ...windowsGitExecutableCandidates(env)]);
  }
  return [command];
}

function spawnWithFallback(command, args, options) {
  let lastResult;
  for (const candidate of commandInvocationsForPlatform(command, args, process.platform, options.env || process.env)) {
    const result = spawnSync(candidate.command, candidate.args, options);
    lastResult = result;
    if (!isRetryableSpawnFailure(command, result)) return { command: candidate.command, result };
  }
  return { command, result: lastResult };
}

function commandInvocationsForPlatform(command, args, platform = process.platform, env = process.env) {
  if (platform === "win32" && command === "npm") {
    return [
      { command: "npm", args },
      { command: "npm.cmd", args },
      { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] },
    ];
  }
  return commandCandidatesForPlatform(command, platform, env).map((candidate) => ({ command: candidate, args }));
}

function isRetryableSpawnFailure(command, result, platform = process.platform) {
  if (result?.error?.code === "ENOENT") return true;
  if (platform === "win32" && command === "npm" && result?.error?.code === "EINVAL") return true;
  return false;
}

export function envWithWindowsGitFallback(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env;
  const gitExe = findWindowsGitExecutable(env, platform);
  if (!gitExe) return env;
  const gitDir = path.dirname(gitExe);
  const keys = pathEnvKeys(env);
  const key = keys[0] || "PATH";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const currentPath = keys.map((pathKey) => env[pathKey]).find(Boolean) || env[key] || "";
  const segments = currentPath.split(delimiter).filter(Boolean);
  if (segments.some((item) => samePath(item, gitDir, platform))) return env;
  const nextPath = currentPath ? `${gitDir}${delimiter}${currentPath}` : gitDir;
  const patched = { ...env };
  for (const pathKey of keys.length > 0 ? keys : [key]) {
    patched[pathKey] = nextPath;
  }
  return {
    ...patched,
  };
}

export function findWindowsGitExecutable(env = process.env, platform = process.platform) {
  if (platform !== "win32") return "";
  return windowsGitExecutableCandidates(env)[0] || "";
}

function windowsGitExecutableCandidates(env = process.env) {
  const candidates = [];
  const addFile = (file) => {
    if (file) candidates.push(file);
  };
  const addRoot = (root) => {
    if (!root) return;
    addFile(path.join(root, "Git", "cmd", "git.exe"));
    addFile(path.join(root, "Git", "bin", "git.exe"));
  };

  addFile(env.PI67_GIT_EXE);
  addRoot(env.ProgramW6432);
  addRoot(env.ProgramFiles);
  addRoot(env["ProgramFiles(x86)"]);
  addFile(path.join(env.LOCALAPPDATA || env.LocalAppData || "", "Programs", "Git", "cmd", "git.exe"));
  addFile(path.join(env.USERPROFILE || env.HOME || "", "scoop", "apps", "git", "current", "cmd", "git.exe"));
  addFile(path.join(env.ChocolateyInstall || "", "bin", "git.exe"));

  return dedupe(candidates).filter((file) => {
    try {
      return fs.existsSync(file) && fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function pathEnvKeys(env) {
  return Object.keys(env).filter((key) => key.toLowerCase() === "path");
}

function samePath(left, right, platform) {
  const normalize = (value) => path.resolve(String(value || "")).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
