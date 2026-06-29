#!/usr/bin/env bash
set -euo pipefail

# Read-only status summary for an installed pi-67 distribution.
# It does not pull, run doctor, install packages, or write pi67-report.json.

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  local dir
  while [ -L "$source" ]; do
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    case "$source" in
      /*) ;;
      *) source="$dir/$source" ;;
    esac
  done
  cd -P "$(dirname "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script_dir)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
OUTPUT_FORMAT="text"
CHECK_REMOTE=true
REMOTE="origin"
BRANCH=""
REMOTE_TIMEOUT_MS=8000

usage() {
  cat <<'USAGE'
pi67-status prints a read-only pi-67 health/update summary.

Usage:
  scripts/pi67-status.sh [options]

Options:
      --repo-root DIR          pi-67 checkout. Defaults to parent of this script.
      --agent-dir DIR          Pi agent dir. Defaults to ~/.pi/agent.
      --remote NAME            Git remote to inspect. Defaults to origin.
      --branch NAME            Remote branch to inspect. Defaults to current branch.
      --no-remote              Do not call git ls-remote.
      --remote-timeout-ms MS   Timeout for remote checks. Defaults to 8000.
      --json                   Emit machine-readable JSON only.
  -h, --help                   Show this help.

This command is read-only. It never runs git pull, doctor, npm install, or report writes.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --agent-dir)
      PI_AGENT_DIR="${2:?--agent-dir requires a path}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:?--remote requires a name}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?--branch requires a name}"
      shift 2
      ;;
    --no-remote)
      CHECK_REMOTE=false
      shift
      ;;
    --remote-timeout-ms)
      REMOTE_TIMEOUT_MS="${2:?--remote-timeout-ms requires a number}"
      shift 2
      ;;
    --json)
      OUTPUT_FORMAT="json"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$REMOTE_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$REMOTE_TIMEOUT_MS" -lt 250 ]; then
  echo "--remote-timeout-ms must be an integer >= 250" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-status" >&2
  exit 1
fi

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$OUTPUT_FORMAT" "$CHECK_REMOTE" "$REMOTE" "$BRANCH" "$REMOTE_TIMEOUT_MS" <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const [
  ,
  ,
  repoRoot,
  agentDir,
  outputFormat,
  checkRemoteArg,
  remoteName,
  branchArg,
  remoteTimeoutMsArg,
] = process.argv;

const outputJson = outputFormat === "json";
const checkRemote = checkRemoteArg === "true";
const remoteTimeoutMs = Number(remoteTimeoutMsArg || "8000");

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: options.timeout || 5000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error ? result.error.message : undefined,
  };
}

function git(args, timeout) {
  return command("git", ["-C", repoRoot, ...args], { cwd: repoRoot, timeout });
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0] || "";
}

function boolText(value) {
  return value ? "yes" : "no";
}

function deriveRepository() {
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    return {
      root: repoRoot,
      isGit: false,
      error: inside.stderr || inside.error || "not a git checkout",
    };
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const fullCommit = git(["rev-parse", "HEAD"]);
  const shortCommit = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const remoteUrl = git(["remote", "get-url", remoteName]);
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  let ahead = null;
  let behind = null;

  if (upstream.ok) {
    const aheadResult = git(["rev-list", "--count", `${upstream.stdout}..HEAD`]);
    const behindResult = git(["rev-list", "--count", `HEAD..${upstream.stdout}`]);
    ahead = aheadResult.ok ? Number(aheadResult.stdout) : null;
    behind = behindResult.ok ? Number(behindResult.stdout) : null;
  }

  return {
    root: repoRoot,
    isGit: true,
    branch: branch.ok && branch.stdout !== "HEAD" ? branch.stdout : null,
    fullCommit: fullCommit.ok ? fullCommit.stdout : null,
    shortCommit: shortCommit.ok ? shortCommit.stdout : null,
    dirty: dirty.ok ? dirty.stdout.length > 0 : null,
    dirtyCount: dirty.ok && dirty.stdout ? dirty.stdout.split(/\r?\n/).filter(Boolean).length : 0,
    remote: remoteName,
    remoteUrl: remoteUrl.ok ? remoteUrl.stdout : null,
    upstream: upstream.ok ? upstream.stdout : null,
    ahead,
    behind,
  };
}

function deriveRemote(repository) {
  const targetBranch = branchArg || repository.branch;
  if (!checkRemote) {
    return {
      checked: false,
      branch: targetBranch,
      status: "skipped",
      summary: "remote check skipped",
    };
  }

  if (!repository.isGit) {
    return {
      checked: false,
      branch: targetBranch,
      status: "unknown",
      summary: "not a git checkout",
    };
  }

  if (!targetBranch) {
    return {
      checked: false,
      branch: null,
      status: "unknown",
      summary: "detached HEAD; pass --branch to inspect a remote branch",
    };
  }

  const remoteRef = `refs/heads/${targetBranch}`;
  const remoteHead = command("git", ["-C", repoRoot, "ls-remote", remoteName, remoteRef], {
    cwd: repoRoot,
    timeout: remoteTimeoutMs,
  });
  const remoteFull = firstLine(remoteHead.stdout).split(/\s+/)[0] || "";

  if (!remoteHead.ok || !remoteFull) {
    return {
      checked: true,
      branch: targetBranch,
      status: "unknown",
      summary: remoteHead.error || remoteHead.stderr || "could not read remote head",
      timeoutMs: remoteTimeoutMs,
    };
  }

  const remoteShort = remoteFull.slice(0, 7);
  if (remoteFull === repository.fullCommit) {
    return {
      checked: true,
      branch: targetBranch,
      status: "current",
      fullCommit: remoteFull,
      shortCommit: remoteShort,
      summary: "local checkout matches remote head",
    };
  }

  const known = git(["cat-file", "-e", `${remoteFull}^{commit}`]);
  if (!known.ok) {
    return {
      checked: true,
      branch: targetBranch,
      status: "remote_different",
      fullCommit: remoteFull,
      shortCommit: remoteShort,
      summary: "remote has a commit not present in the local object database",
    };
  }

  const localAncestor = git(["merge-base", "--is-ancestor", repository.fullCommit, remoteFull]);
  if (localAncestor.ok) {
    return {
      checked: true,
      branch: targetBranch,
      status: "behind",
      fullCommit: remoteFull,
      shortCommit: remoteShort,
      summary: "local checkout is behind remote",
    };
  }

  const remoteAncestor = git(["merge-base", "--is-ancestor", remoteFull, repository.fullCommit]);
  if (remoteAncestor.ok) {
    return {
      checked: true,
      branch: targetBranch,
      status: "ahead",
      fullCommit: remoteFull,
      shortCommit: remoteShort,
      summary: "local checkout is ahead of remote",
    };
  }

  return {
    checked: true,
    branch: targetBranch,
    status: "diverged",
    fullCommit: remoteFull,
    shortCommit: remoteShort,
    summary: "local and remote histories appear diverged",
  };
}

function deriveReport(repository, version) {
  const reportPath = path.join(agentDir, "pi67-report.json");
  const exists = fs.existsSync(reportPath);
  const base = {
    path: reportPath,
    exists,
    valid: false,
    stale: true,
    staleReasons: [],
  };

  if (!exists) {
    base.staleReasons.push("report missing");
    return base;
  }

  const parsed = readJson(reportPath);
  if (!parsed.ok) {
    base.error = parsed.error;
    base.staleReasons.push("report is not valid JSON");
    return base;
  }

  const report = parsed.data;
  const reportVersion = report.pi67?.version || report.pi67Version || "";
  const reportShort = report.repository?.shortCommit || "";
  const reportDirty = report.repository?.dirty;
  const doctor = report.doctor || null;

  base.valid = true;
  base.stale = false;
  base.schemaVersion = report.schemaVersion ?? null;
  base.schemaId = report.schemaId || null;
  base.generatedAt = report.generatedAt || null;
  base.operation = report.operation || null;
  base.pi67Version = reportVersion || null;
  base.commit = reportShort || null;
  base.dirty = typeof reportDirty === "boolean" ? reportDirty : null;
  base.doctor = doctor
    ? {
        skipped: Boolean(doctor.skipped),
        schemaVersion: doctor.schemaVersion ?? null,
        schemaId: doctor.schemaId || null,
        result: doctor.result || null,
        counts: doctor.counts || null,
        parseError: doctor.parseError || null,
      }
    : null;

  if (Number(report.schemaVersion || 0) < 2) {
    base.staleReasons.push(`report schemaVersion ${report.schemaVersion ?? "missing"} < 2`);
  }

  if (version && reportVersion !== version) {
    base.staleReasons.push(`report version ${reportVersion || "unknown"} != ${version}`);
  }

  if (repository.shortCommit && reportShort !== repository.shortCommit) {
    base.staleReasons.push(`report commit ${reportShort || "unknown"} != ${repository.shortCommit}`);
  }

  if (typeof repository.dirty === "boolean" && typeof reportDirty === "boolean" && reportDirty !== repository.dirty) {
    base.staleReasons.push(`report dirty ${reportDirty} != ${repository.dirty}`);
  }

  if (doctor && doctor.skipped !== true && Number(doctor.schemaVersion || 0) < 2) {
    base.staleReasons.push(`doctor schemaVersion ${doctor.schemaVersion ?? "missing"} < 2`);
  }

  base.stale = base.staleReasons.length > 0;
  return base;
}

function deriveResult(repository, remote, report) {
  const recommendations = [];
  const warnings = [];
  const blockers = [];

  if (!repository.isGit) {
    blockers.push("repository is not a git checkout");
  }

  if (repository.dirty) {
    warnings.push(`worktree has ${repository.dirtyCount} local change(s)`);
    recommendations.push("Commit or stash local pi-67 checkout changes before updating.");
  }

  if (["behind", "remote_different"].includes(remote.status)) {
    warnings.push(remote.summary);
    recommendations.push("Run: bash ~/.pi/agent/scripts/pi67-update.sh");
  } else if (remote.status === "diverged") {
    blockers.push(remote.summary);
    recommendations.push("Resolve the local/remote branch divergence before running pi67-update.");
  } else if (remote.status === "unknown") {
    warnings.push(`remote status unknown: ${remote.summary}`);
    recommendations.push("Run: bash ~/.pi/agent/scripts/pi67-update.sh --check-only");
  }

  if (!report.exists) {
    warnings.push("pi67-report.json is missing");
    recommendations.push("Run: bash ~/.pi/agent/scripts/pi67-report.sh --operation manual");
  } else if (!report.valid) {
    blockers.push("pi67-report.json is invalid JSON");
    recommendations.push("Regenerate the report with: bash ~/.pi/agent/scripts/pi67-report.sh --operation manual");
  } else if (report.stale) {
    warnings.push(`report is stale: ${report.staleReasons.join("; ")}`);
    recommendations.push("Regenerate the report after doctor: bash ~/.pi/agent/scripts/pi67-report.sh --operation manual");
  }

  const doctor = report.doctor;
  if (doctor) {
    if (doctor.parseError) {
      warnings.push(`doctor parse error in report: ${doctor.parseError}`);
      recommendations.push("Run: bash ~/.pi/agent/scripts/pi67-doctor.sh --json");
    } else if (doctor.skipped) {
      warnings.push("doctor was skipped in the current report");
      recommendations.push("Run: bash ~/.pi/agent/scripts/pi67-doctor.sh");
    } else if ((doctor.counts?.fail || 0) > 0) {
      blockers.push(`doctor has ${doctor.counts.fail} failure(s)`);
      recommendations.push("Fix doctor FAIL items, then rerun pi67-doctor and pi67-report.");
    } else if ((doctor.counts?.warn || 0) > 0) {
      warnings.push(`doctor has ${doctor.counts.warn} warning(s)`);
      recommendations.push("Use pi67-configure for missing local keys/paths, then rerun pi67-doctor.");
    }
  } else if (report.valid) {
    warnings.push("report has no doctor block");
    recommendations.push("Regenerate the report with doctor enabled.");
  }

  const uniqueRecommendations = [...new Set(recommendations)];
  let result = "READY";
  if (blockers.length > 0) {
    result = "ACTION_REQUIRED";
  } else if (["behind", "remote_different"].includes(remote.status)) {
    result = "UPDATE_AVAILABLE";
  } else if (warnings.length > 0) {
    result = "READY_WITH_WARNINGS";
  }

  return {
    result,
    blockers,
    warnings,
    recommendations: uniqueRecommendations.length > 0 ? uniqueRecommendations : ["No immediate action."],
  };
}

function resultText(result) {
  return result.replace(/_/g, " ");
}

const version = readText(path.join(repoRoot, "VERSION")).trim() || null;
const packageJson = readJson(path.join(repoRoot, "package.json"));
const packageVersion = packageJson.ok ? packageJson.data.version || null : null;
const repository = deriveRepository();
const remote = deriveRemote(repository);
const report = deriveReport(repository, version);
const status = deriveResult(repository, remote, report);

const output = {
  schemaVersion: 1,
  schemaId: "pi67-status/v1",
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/pi67-status.sh",
  pi67: {
    version,
    packageVersion,
  },
  repository,
  remote,
  agent: {
    dir: agentDir,
  },
  report,
  result: status.result,
  blockers: status.blockers,
  warnings: status.warnings,
  recommendations: status.recommendations,
};

if (outputJson) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log("");
console.log("pi-67 status");
console.log(`Repository : ${repoRoot}`);
console.log(`Agent dir  : ${agentDir}`);
console.log("");
console.log("--- distribution ---");
console.log(`Version    : ${version || "unknown"}`);
console.log(`Package    : ${packageVersion || "unknown"}`);
console.log(`Branch     : ${repository.branch || "unknown"}`);
console.log(`Commit     : ${repository.shortCommit || "unknown"}`);
console.log(`Dirty      : ${boolText(Boolean(repository.dirty))}${repository.dirty ? ` (${repository.dirtyCount} change(s))` : ""}`);
console.log(`Remote     : ${remote.status}${remote.shortCommit ? ` (${remote.shortCommit})` : ""}`);
console.log(`Remote note: ${remote.summary}`);
if (repository.upstream) {
  console.log(`Tracking   : ${repository.upstream} (ahead=${repository.ahead ?? "unknown"} behind=${repository.behind ?? "unknown"})`);
}
console.log("");
console.log("--- report ---");
if (!report.exists) {
  console.log(`Path       : ${report.path}`);
  console.log("State      : missing");
} else if (!report.valid) {
  console.log(`Path       : ${report.path}`);
  console.log(`State      : invalid JSON (${report.error})`);
} else {
  console.log(`Path       : ${report.path}`);
  console.log(`Schema     : ${report.schemaId || "unknown"} (${report.schemaVersion ?? "missing"})`);
  console.log(`Generated  : ${report.generatedAt || "unknown"}`);
  console.log(`Operation  : ${report.operation || "unknown"}`);
  console.log(`Fresh      : ${report.stale ? "no" : "yes"}`);
  if (report.stale) {
    console.log(`Stale why  : ${report.staleReasons.join("; ")}`);
  }
  if (report.doctor) {
    if (report.doctor.skipped) {
      console.log("Doctor     : SKIPPED");
    } else if (report.doctor.parseError) {
      console.log(`Doctor     : parse error (${report.doctor.parseError})`);
    } else {
      const counts = report.doctor.counts || {};
      console.log(`Doctor     : ${report.doctor.result || "unknown"} (pass=${counts.pass ?? "?"} warn=${counts.warn ?? "?"} fail=${counts.fail ?? "?"})`);
      if (report.doctor.schemaId) {
        console.log(`Doctor sch : ${report.doctor.schemaId} (${report.doctor.schemaVersion ?? "missing"})`);
      }
    }
  } else {
    console.log("Doctor     : missing");
  }
}
console.log("");
console.log("--- recommendation ---");
for (const item of status.recommendations) {
  console.log(`- ${item}`);
}
console.log("");
console.log(`Result: ${resultText(status.result)}`);
NODE
