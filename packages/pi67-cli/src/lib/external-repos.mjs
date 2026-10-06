import fs from "node:fs";
import path from "node:path";
import { gitStatus, gitText } from "./git.mjs";
import { runNetworkCommand } from "./shell-runner.mjs";
import { CliError } from "./output.mjs";

export const EXTERNAL_REPOS = {
  browser67: {
    name: "browser67",
    repoUrl: "https://github.com/bigKING67/craft67.git",
    sourceDirectory: "packages/browser67",
    description: "Real browser / tmwd_browser / js-reverse runtime repo",
  },
  "design-craft": {
    name: "design-craft",
    repoUrl: "https://github.com/bigKING67/craft67.git",
    sourceDirectory: "packages/design-craft",
    description: "Shared frontend design craft skills repo",
  },
};

export function externalPath(ctx, name) {
  const spec = EXTERNAL_REPOS[name];
  if (!spec) throw new CliError(`unknown external repo: ${name}`, 2);
  return path.join(ctx.packagesDir, "craft67", spec.sourceDirectory);
}

export function listExternal(ctx) {
  return Object.values(EXTERNAL_REPOS).map((repo) => externalStatus(ctx, repo.name));
}

export function externalStatus(ctx, name) {
  const spec = EXTERNAL_REPOS[name];
  if (!spec) throw new CliError(`unknown external repo: ${name}`, 2);
  const dir = externalPath(ctx, name);
  const exists = fs.existsSync(dir);
  const checkoutPath = path.join(ctx.packagesDir, "craft67");
  const git = exists ? gitStatus(checkoutPath) : null;
  return {
    ...spec,
    path: dir,
    checkoutPath,
    exists,
    git,
  };
}

export function installExternal(ctx, name, { dryRun = false, quiet = false, timeoutMs } = {}) {
  const spec = EXTERNAL_REPOS[name];
  if (!spec) throw new CliError(`unknown external repo: ${name}`, 2);
  const dir = externalPath(ctx, name);
  const checkout = path.join(ctx.packagesDir, "craft67");
  if (fs.existsSync(checkout)) {
    assertManagedCheckout(checkout, spec);
    assertPackageDirectory(checkout, dir);
    return { action: "skip", reason: "shared craft67 checkout already exists", status: externalStatus(ctx, name) };
  }
  if (!dryRun) fs.mkdirSync(path.dirname(checkout), { recursive: true });
  runNetworkCommand("git", ["clone", spec.repoUrl, checkout], { dryRun, quiet, timeoutMs });
  if (!dryRun) assertPackageDirectory(checkout, dir);
  return { action: dryRun ? "clone-dry-run" : "clone", status: externalStatus(ctx, name) };
}

export function updateExternal(ctx, name, { dryRun = false, quiet = false, timeoutMs } = {}) {
  const status = externalStatus(ctx, name);
  if (!status.exists) {
    throw new CliError(`external repo is not installed; run: pi-67 external install ${name}`);
  }
  if (!status.git?.isRepo) {
    throw new CliError(`external path is not a git repo: ${status.path}`);
  }
  assertManagedCheckout(status.checkoutPath, EXTERNAL_REPOS[name]);
  assertPackageDirectory(status.checkoutPath, status.path);
  if (status.git.dirty) {
    throw new CliError(`external repo is dirty; not updating: ${status.path}`);
  }
  const branch = gitText(status.checkoutPath, ["branch", "--show-current"]);
  if (!branch) {
    throw new CliError(`external repo is detached; not updating: ${status.path}`);
  }
  const fromCommit = status.git.commit;
  runNetworkCommand("git", ["-C", status.checkoutPath, "pull", "--ff-only"], { dryRun, quiet, timeoutMs });
  if (!dryRun) assertPackageDirectory(status.checkoutPath, status.path);
  const nextStatus = externalStatus(ctx, name);
  return {
    action: dryRun ? "pull-dry-run" : "pull",
    changed: dryRun ? null : fromCommit !== nextStatus.git?.commit,
    fromCommit,
    toCommit: nextStatus.git?.commit || "",
    status: nextStatus,
  };
}

function assertManagedCheckout(checkout, spec) {
  const normalize = (value) => value.replace(/\.git$/u, "").replace(/\/$/u, "");
  const top = gitText(checkout, ["rev-parse", "--show-toplevel"]);
  if (!top || path.relative(fs.realpathSync.native(top), fs.realpathSync.native(checkout)) !== ""
    || normalize(gitText(checkout, ["remote", "get-url", "origin"])) !== normalize(spec.repoUrl)) {
    throw new CliError(`external checkout is not the expected craft67 repository: ${checkout}`);
  }
}

function assertPackageDirectory(checkout, directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new CliError(`craft67 package directory is missing: ${directory}; update the shared checkout first`);
  }
  const relative = path.relative(fs.realpathSync(checkout), fs.realpathSync(directory));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CliError(`craft67 package directory escapes its checkout: ${directory}`);
  }
}
