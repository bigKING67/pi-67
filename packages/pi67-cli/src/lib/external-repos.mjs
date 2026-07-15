import fs from "node:fs";
import path from "node:path";
import { gitStatus, gitText } from "./git.mjs";
import { runCommand } from "./shell-runner.mjs";
import { CliError } from "./output.mjs";

export const EXTERNAL_REPOS = {
  browser67: {
    name: "browser67",
    repoUrl: "https://github.com/bigKING67/browser67.git",
    description: "Real browser / tmwd_browser / js-reverse runtime repo",
  },
  "design-craft": {
    name: "design-craft",
    repoUrl: "https://github.com/bigKING67/design-craft",
    description: "Shared frontend design craft skills repo",
  },
};

export function externalPath(ctx, name) {
  return path.join(ctx.packagesDir, name);
}

export function listExternal(ctx) {
  return Object.values(EXTERNAL_REPOS).map((repo) => externalStatus(ctx, repo.name));
}

export function externalStatus(ctx, name) {
  const spec = EXTERNAL_REPOS[name];
  if (!spec) throw new CliError(`unknown external repo: ${name}`, 2);
  const dir = externalPath(ctx, name);
  const exists = fs.existsSync(dir);
  const git = exists ? gitStatus(dir) : null;
  return {
    ...spec,
    path: dir,
    exists,
    git,
  };
}

export function installExternal(ctx, name, { dryRun = false, quiet = false } = {}) {
  const spec = EXTERNAL_REPOS[name];
  if (!spec) throw new CliError(`unknown external repo: ${name}`, 2);
  const dir = externalPath(ctx, name);
  if (fs.existsSync(dir)) {
    return { action: "skip", reason: "already exists", status: externalStatus(ctx, name) };
  }
  if (!dryRun) fs.mkdirSync(path.dirname(dir), { recursive: true });
  runCommand("git", ["clone", spec.repoUrl, dir], { dryRun, quiet });
  return { action: dryRun ? "clone-dry-run" : "clone", status: externalStatus(ctx, name) };
}

export function updateExternal(ctx, name, { dryRun = false, quiet = false } = {}) {
  const status = externalStatus(ctx, name);
  if (!status.exists) {
    throw new CliError(`external repo is not installed; run: pi-67 external install ${name}`);
  }
  if (!status.git?.isRepo) {
    throw new CliError(`external path is not a git repo: ${status.path}`);
  }
  if (status.git.dirty) {
    throw new CliError(`external repo is dirty; not updating: ${status.path}`);
  }
  const branch = gitText(status.path, ["branch", "--show-current"]);
  if (!branch) {
    throw new CliError(`external repo is detached; not updating: ${status.path}`);
  }
  const fromCommit = status.git.commit;
  runCommand("git", ["-C", status.path, "pull", "--ff-only"], { dryRun, quiet });
  const nextStatus = externalStatus(ctx, name);
  return {
    action: dryRun ? "pull-dry-run" : "pull",
    changed: dryRun ? null : fromCommit !== nextStatus.git?.commit,
    fromCommit,
    toCommit: nextStatus.git?.commit || "",
    status: nextStatus,
  };
}
