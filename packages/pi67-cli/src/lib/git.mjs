import path from "node:path";
import { captureCommand } from "./shell-runner.mjs";

export function isGitRepo(repoRoot) {
  return captureCommand("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]).ok;
}

export function gitText(repoRoot, args, fallback = "") {
  const result = captureCommand("git", ["-C", repoRoot, ...args]);
  return result.ok ? result.stdout.trim() : fallback;
}

export function gitStatus(repoRoot) {
  if (!isGitRepo(repoRoot)) {
    return { ok: false, isRepo: false, dirty: false, short: "", branch: "", commit: "" };
  }
  const short = gitText(repoRoot, ["status", "--short"]);
  const branchLine = gitText(repoRoot, ["status", "--short", "--branch"]).split(/\r?\n/)[0] || "";
  const branch = gitText(repoRoot, ["branch", "--show-current"], "detached");
  const commit = gitText(repoRoot, ["rev-parse", "--short=12", "HEAD"]);
  const remote = gitText(repoRoot, ["remote", "get-url", "origin"]);
  return {
    ok: true,
    isRepo: true,
    dirty: short.length > 0,
    short,
    branchLine,
    branch,
    commit,
    remote,
  };
}

export function remoteHead(repoRoot, remote = "origin", branch = "") {
  const currentBranch = branch || gitText(repoRoot, ["branch", "--show-current"]);
  if (!currentBranch) {
    return { ok: false, branch: "", commit: "", message: "no current branch" };
  }
  const remoteUrl = gitText(repoRoot, ["remote", "get-url", remote]);
  if (!remoteUrl) {
    return { ok: false, branch: currentBranch, commit: "", message: `missing remote: ${remote}` };
  }
  const result = captureCommand("git", ["ls-remote", "--heads", remoteUrl, currentBranch], {
    timeoutMs: 8000,
  });
  if (!result.ok) {
    return { ok: false, branch: currentBranch, commit: "", message: (result.stderr || result.error || "").trim() };
  }
  const commit = result.stdout.trim().split(/\s+/)[0] || "";
  return { ok: Boolean(commit), branch: currentBranch, commit, message: commit ? "" : "remote branch not found" };
}

export function relativeRepoPath(repoRoot, file) {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}
