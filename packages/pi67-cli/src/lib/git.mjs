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
  const porcelain = captureCommand("git", ["-C", repoRoot, "status", "--porcelain=v1", "--branch"]);
  if (!porcelain.ok) {
    return {
      ok: false,
      isRepo: false,
      dirty: false,
      short: "",
      branchLine: "",
      branch: "",
      commit: "",
      headCommit: "",
      remote: "",
    };
  }
  const parsed = parseGitStatusPorcelain(porcelain.stdout);
  const headCommit = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const remote = gitText(repoRoot, ["remote", "get-url", "origin"]);
  return {
    ok: true,
    isRepo: true,
    dirty: parsed.short.length > 0,
    short: parsed.short,
    branchLine: parsed.branchLine,
    branch: parsed.branch,
    commit: headCommit.slice(0, 12),
    headCommit,
    remote,
  };
}

export function parseGitStatusPorcelain(output) {
  const lines = String(output || "").replace(/(?:\r?\n)+$/, "").split(/\r?\n/);
  const branchLine = lines[0]?.startsWith("## ") ? lines.shift() : "";
  const short = lines.filter(Boolean).join("\n");
  return {
    branchLine,
    branch: parseBranchLine(branchLine),
    short,
  };
}

export function gitReleaseStatus(repoRoot, options = {}) {
  const expectedBranch = options.expectedBranch || "main";
  const remoteName = options.remote || "origin";
  const status = gitStatus(repoRoot);
  if (!status.isRepo) {
    return {
      ...status,
      expectedBranch,
      remoteName,
      remoteRef: `${remoteName}/${expectedBranch}`,
      headCommit: "",
      remoteTrackingCommit: "",
      liveRemote: { skipped: !options.verifyRemote, ok: false, branch: expectedBranch, commit: "", message: "not a git checkout" },
      ready: false,
      problems: ["repo root is not a git checkout"],
    };
  }

  const headCommit = status.headCommit || gitText(repoRoot, ["rev-parse", "HEAD"]);
  const remoteRef = `${remoteName}/${expectedBranch}`;
  const remoteTrackingCommit = gitText(repoRoot, ["rev-parse", "--verify", `refs/remotes/${remoteRef}`]);
  const remoteUrl = remoteName === "origin"
    ? status.remote
    : gitText(repoRoot, ["remote", "get-url", remoteName]);
  const liveRemote = options.verifyRemote
    ? remoteHead(repoRoot, remoteName, expectedBranch, { remoteUrl })
    : { skipped: true, ok: false, branch: expectedBranch, commit: "", message: "live remote check skipped" };
  const problems = [];
  if (status.dirty) problems.push("repo has local changes");
  if (!status.branch) problems.push("HEAD is detached");
  else if (status.branch !== expectedBranch) problems.push(`release branch must be ${expectedBranch}, got ${status.branch}`);
  if (!remoteTrackingCommit) problems.push(`missing remote-tracking ref ${remoteRef}`);
  else if (headCommit !== remoteTrackingCommit) problems.push(`HEAD does not match ${remoteRef}`);
  if (options.verifyRemote) {
    if (!liveRemote.ok) problems.push(`could not resolve live ${remoteRef}: ${liveRemote.message || "unknown error"}`);
    else if (headCommit !== liveRemote.commit) problems.push(`HEAD does not match live ${remoteRef}`);
  }

  return {
    ...status,
    expectedBranch,
    remoteName,
    remoteRef,
    headCommit,
    remoteTrackingCommit,
    liveRemote,
    ready: problems.length === 0,
    problems,
  };
}

export function remoteHead(repoRoot, remote = "origin", branch = "", options = {}) {
  const currentBranch = branch || gitText(repoRoot, ["branch", "--show-current"]);
  if (!currentBranch) {
    return { ok: false, branch: "", commit: "", message: "no current branch" };
  }
  const remoteUrl = options.remoteUrl || gitText(repoRoot, ["remote", "get-url", remote]);
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

function parseBranchLine(branchLine) {
  const value = branchLine.startsWith("## ") ? branchLine.slice(3) : "";
  if (!value || value === "HEAD" || value.startsWith("HEAD (")) return "";
  for (const prefix of ["No commits yet on ", "Initial commit on "]) {
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return value.split("...")[0].replace(/ \[.*$/, "").trim();
}

export function relativeRepoPath(repoRoot, file) {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}
