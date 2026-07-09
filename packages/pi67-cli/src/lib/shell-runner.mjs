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

export function repairWindowsGitPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== "win32") {
    return { ok: true, supported: false, found: false, persisted: false, processPathPatched: false };
  }

  const gitExe = findWindowsGitExecutable(env, platform);
  if (!gitExe) {
    return { ok: false, supported: true, found: false, persisted: false, processPathPatched: false };
  }

  const gitDir = path.dirname(gitExe);
  const currentPath = currentPathValue(env);
  const processPathAlreadyHadGit = pathListContainsDirectory(currentPath, gitDir, platform);
  let processPathPatched = false;
  if (!processPathAlreadyHadGit) {
    setPathValue(env, prependPathDirectory(currentPath, gitDir, platform));
    processPathPatched = true;
  }

  const persistence = options.persistUserPath
    ? persistWindowsUserPathDirectory(gitDir, {
        dryRun: options.dryRun,
        env,
        platform,
        powerShellCommands: options.powerShellCommands,
        spawnImpl: options.spawnImpl,
      })
    : { ok: true, supported: true, persisted: false, alreadyPresent: false, skipped: true };

  return {
    ok: Boolean(persistence.ok),
    supported: true,
    found: true,
    gitExe,
    gitDir,
    processPathAlreadyHadGit,
    processPathPatched,
    persisted: Boolean(persistence.persisted),
    alreadyPersisted: Boolean(persistence.alreadyPresent),
    persistence,
  };
}

export function persistWindowsUserPathDirectory(directory, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return { ok: true, supported: false, persisted: false, alreadyPresent: false };
  }
  if (!directory) {
    return { ok: false, supported: true, persisted: false, alreadyPresent: false, error: "directory is required" };
  }
  if (options.dryRun) {
    return { ok: true, supported: true, persisted: false, alreadyPresent: false, dryRun: true };
  }

  const spawnImpl = options.spawnImpl || spawnSync;
  const env = { ...process.env, ...(options.env || {}), PI67_GIT_DIR_TO_PERSIST: directory };
  const encodedScript = Buffer.from(windowsUserPathPersistScript(), "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript];
  const attempts = [];

  for (const command of windowsPowerShellCandidates(env, options.powerShellCommands)) {
    const result = spawnImpl(command, args, {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    attempts.push({
      command,
      status: result.status,
      error: result.error ? result.error.message : "",
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    });
    if (result.status === 0 && !result.error) {
      const stdout = String(result.stdout || "").trim();
      return {
        ok: true,
        supported: true,
        persisted: stdout.includes("updated"),
        alreadyPresent: stdout.includes("already-present"),
        command,
        attempts,
      };
    }
  }

  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    supported: true,
    persisted: false,
    alreadyPresent: false,
    attempts,
    error: last.stderr || last.error || "failed to persist Windows user PATH",
  };
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
  const currentPath = currentPathValue(env);
  if (pathListContainsDirectory(currentPath, gitDir, platform)) return env;
  const patched = { ...env };
  setPathValue(patched, prependPathDirectory(currentPath, gitDir, platform));
  return patched;
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

function currentPathValue(env) {
  const keys = pathEnvKeys(env);
  const key = keys[0] || "PATH";
  return keys.map((pathKey) => env[pathKey]).find(Boolean) || env[key] || "";
}

function setPathValue(env, value) {
  const keys = pathEnvKeys(env);
  for (const pathKey of keys.length > 0 ? keys : ["PATH"]) {
    env[pathKey] = value;
  }
}

function prependPathDirectory(currentPath, directory, platform) {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return currentPath ? `${directory}${delimiter}${currentPath}` : directory;
}

function pathListContainsDirectory(pathValue, directory, platform) {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return String(pathValue || "")
    .split(delimiter)
    .filter(Boolean)
    .some((item) => samePath(item, directory, platform));
}

function samePath(left, right, platform) {
  const normalize = (value) => path.resolve(String(value || "")).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function windowsPowerShellCandidates(env = process.env, explicitCandidates) {
  if (explicitCandidates && explicitCandidates.length > 0) return dedupe(explicitCandidates);
  return dedupe([
    "pwsh",
    "pwsh.exe",
    "powershell",
    "powershell.exe",
    path.join(env.SystemRoot || env.SYSTEMROOT || "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]);
}

function windowsUserPathPersistScript() {
  return `
$ErrorActionPreference = 'Stop'
$gitDir = $env:PI67_GIT_DIR_TO_PERSIST
if ([string]::IsNullOrWhiteSpace($gitDir)) {
  throw 'PI67_GIT_DIR_TO_PERSIST is empty'
}
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) {
  $current = ''
}
$target = ($gitDir.Trim() -replace '[\\\\/]+$', '')
$exists = $false
foreach ($segment in ($current -split ';')) {
  $normalized = ($segment.Trim() -replace '[\\\\/]+$', '')
  if ($normalized.Length -gt 0 -and [string]::Equals($normalized, $target, [StringComparison]::OrdinalIgnoreCase)) {
    $exists = $true
    break
  }
}
if ($exists) {
  Write-Output 'already-present'
  exit 0
}
$newPath = if ([string]::IsNullOrWhiteSpace($current)) { $gitDir } else { "$gitDir;$current" }
[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
Write-Output 'updated'
`;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
