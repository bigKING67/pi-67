import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO_URL = "https://github.com/bigKING67/pi-67.git";

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function readCliPackageJson() {
  const file = path.join(packageRoot(), "package.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveContext(globalOptions = {}) {
  const agentDir = path.resolve(expandHome(
    globalOptions.agentDir ||
      process.env.PI67_AGENT_DIR ||
      process.env.PI_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".pi", "agent"),
  ));
  const repoRoot = path.resolve(expandHome(globalOptions.repoRoot || agentDir));
  const skillsDir = path.resolve(expandHome(
    globalOptions.skillsDir ||
      process.env.PI67_SKILLS_DIR ||
      path.join(os.homedir(), ".agents", "skills"),
  ));
  const packagesDir = path.resolve(expandHome(
    globalOptions.packagesDir ||
      process.env.PI67_PACKAGES_DIR ||
      path.join(os.homedir(), ".agents", "packages"),
  ));
  const stateDir = path.join(os.homedir(), ".pi", "pi67");
  return {
    agentDir,
    repoRoot,
    skillsDir,
    packagesDir,
    stateDir,
    reportsDir: path.join(stateDir, "reports"),
    logsDir: path.join(stateDir, "logs"),
    json: Boolean(globalOptions.json),
    dryRun: Boolean(globalOptions.dryRun),
    yes: Boolean(globalOptions.yes),
    noRemote: Boolean(globalOptions.noRemote),
  };
}

export function scriptPath(ctx, scriptName) {
  return path.join(ctx.repoRoot, "scripts", scriptName);
}

export function pathExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
