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
XTALPI_SMOKE=true
XTALPI_SMOKE_DIR="${PI67_XTALPI_SMOKE_DIR:-}"
XTALPI_SMOKE_HISTORY=3
XTALPI_SMOKE_TREND=3
XTALPI_SMOKE_DRIFT=10
XTALPI_SMOKE_TIMEOUT_MS=15000

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
      --no-xtalpi-smoke        Do not summarize local xtalpi smoke artifacts.
      --xtalpi-smoke-dir DIR   Smoke artifact dir. Defaults to ~/tmp/xtalpi-pi-tools-smoke.
      --xtalpi-smoke-history N Number of newest smoke runs to summarize. Defaults to 3.
      --xtalpi-smoke-trend N   Number of newest smoke runs for full-suite-strict trend gate. Defaults to 3.
      --xtalpi-smoke-drift N   Number of newest full-suite smoke runs for drift summary. Defaults to 10.
      --xtalpi-smoke-timeout-ms MS
                               Timeout per debug-summary command. Defaults to 15000.
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
    --no-xtalpi-smoke)
      XTALPI_SMOKE=false
      shift
      ;;
    --xtalpi-smoke-dir)
      XTALPI_SMOKE_DIR="${2:?--xtalpi-smoke-dir requires a path}"
      shift 2
      ;;
    --xtalpi-smoke-history)
      XTALPI_SMOKE_HISTORY="${2:?--xtalpi-smoke-history requires a number}"
      shift 2
      ;;
    --xtalpi-smoke-trend)
      XTALPI_SMOKE_TREND="${2:?--xtalpi-smoke-trend requires a number}"
      shift 2
      ;;
    --xtalpi-smoke-drift)
      XTALPI_SMOKE_DRIFT="${2:?--xtalpi-smoke-drift requires a number}"
      shift 2
      ;;
    --xtalpi-smoke-timeout-ms)
      XTALPI_SMOKE_TIMEOUT_MS="${2:?--xtalpi-smoke-timeout-ms requires a number}"
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

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$OUTPUT_FORMAT" "$CHECK_REMOTE" "$REMOTE" "$BRANCH" "$REMOTE_TIMEOUT_MS" "$XTALPI_SMOKE" "$XTALPI_SMOKE_DIR" "$XTALPI_SMOKE_HISTORY" "$XTALPI_SMOKE_TREND" "$XTALPI_SMOKE_DRIFT" "$XTALPI_SMOKE_TIMEOUT_MS" "$SCRIPT_DIR" <<'NODE'
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
  xtalpiSmokeArg,
  xtalpiSmokeDirArg,
  xtalpiSmokeHistoryArg,
  xtalpiSmokeTrendArg,
  xtalpiSmokeDriftArg,
  xtalpiSmokeTimeoutMsArg,
  scriptDir,
] = process.argv;

const outputJson = outputFormat === "json";
const checkRemote = checkRemoteArg === "true";
const remoteTimeoutMs = Number(remoteTimeoutMsArg || "8000");
const xtalpiSmokeEnabled = xtalpiSmokeArg === "true";
const { collectXtalpiSmokeStatus, defaultArtifactDir } = require(path.join(scriptDir, "pi67-xtalpi-smoke-status-core.cjs"));

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

function parsePorcelainPaths(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const rawPath = line[2] === " " ? line.slice(3) : line[1] === " " ? line.slice(2) : line.slice(3);
      const renameIndex = rawPath.indexOf(" -> ");
      return renameIndex >= 0 ? rawPath.slice(renameIndex + 4) : rawPath;
    })
    .filter(Boolean);
}

function deriveLocalState(dirtyOutput) {
  const lines = String(dirtyOutput || "").split(/\r?\n/).filter(Boolean);
  const paths = parsePorcelainPaths(dirtyOutput);
  const result = {
    paths,
    rawLines: lines,
    benignRuntimeOnly: false,
    benignRuntimeReasons: [],
  };

  if (paths.length !== 1 || paths[0] !== "settings.json") return result;

  const diff = git(["diff", "--", "settings.json"], 5000);
  if (!diff.ok) return result;
  const changedLines = diff.stdout
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));

  if (changedLines.length === 0) return result;

  const allowed = changedLines.every((line) => {
    const body = line.slice(1).trim();
    return body === "}" || /^"lastChangelogVersion"\s*:/.test(body);
  });
  if (!allowed) return result;

  result.benignRuntimeOnly = true;
  if (changedLines.some((line) => /^[-+]\s*"lastChangelogVersion"\s*:/.test(line))) {
    result.benignRuntimeReasons.push("settings.json lastChangelogVersion runtime marker changed");
  }
  if (changedLines.some((line) => /^[-+]\s*}\s*$/.test(line))) {
    result.benignRuntimeReasons.push("settings.json trailing newline state changed");
  }
  return result;
}

function latencyText(run) {
  return (
    `request_latency_ms=${run?.requestLatencyMsMax ?? "?"}/${run?.requestLatencyMsAvg ?? "?"}/${run?.requestCount ?? "?"} ` +
    `slow_requests=${run?.slowRequestCount ?? "?"} ` +
    `slow_request_threshold_ms=${run?.slowRequestThresholdMs ?? "?"}`
  );
}

function realPathMaybe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function deriveInstallMode() {
  return realPathMaybe(repoRoot) === realPathMaybe(agentDir) ? "in-place" : "linked";
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
  const localState = dirty.ok ? deriveLocalState(dirty.stdout) : {
    paths: [],
    rawLines: [],
    benignRuntimeOnly: false,
    benignRuntimeReasons: [],
  };
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
    localState,
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

function deriveResult(repository, remote, report, xtalpiSmoke) {
  const recommendations = [];
  const warnings = [];
  const blockers = [];
  const updateCommand = installMode === "in-place"
    ? `Run: git -C ${agentDir} pull --ff-only`
    : "Run: bash ~/.pi/agent/scripts/pi67-update.sh";
  const updateCheckCommand = installMode === "in-place"
    ? `Run: bash ${path.join(agentDir, "scripts", "pi67-update.sh")} --check-only`
    : "Run: bash ~/.pi/agent/scripts/pi67-update.sh --check-only";

  if (!repository.isGit) {
    blockers.push("repository is not a git checkout");
  }

  if (repository.dirty) {
    if (repository.localState?.benignRuntimeOnly) {
      recommendations.push("Optional: normalize local settings runtime marker if you want a clean git status.");
    } else {
      warnings.push(`worktree has ${repository.dirtyCount} local change(s)`);
      recommendations.push("Commit or stash local pi-67 checkout changes before updating.");
    }
  }

  if (["behind", "remote_different"].includes(remote.status)) {
    warnings.push(remote.summary);
    recommendations.push(updateCommand);
    if (installMode === "in-place") {
      recommendations.push(`Or run: bash ${path.join(agentDir, "scripts", "pi67-update.sh")}`);
    }
  } else if (remote.status === "diverged") {
    blockers.push(remote.summary);
    recommendations.push("Resolve the local/remote branch divergence before running pi67-update.");
  } else if (remote.status === "unknown") {
    warnings.push(`remote status unknown: ${remote.summary}`);
    recommendations.push(updateCheckCommand);
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

  if (xtalpiSmoke && xtalpiSmoke.skipped !== true) {
    const providerTrend = xtalpiSmoke.providerHealthTrend;
    if (providerTrend?.failedPreflights > 0) {
      warnings.push(
        `xtalpi provider-health has ${providerTrend.failedPreflights}/${providerTrend.totalPreflights} recent failed preflight(s)`,
      );
      recommendations.push("Inspect xtalpi provider health before long tasks; failures usually indicate upstream/network/key issues, not local tool protocol.");
    } else if (providerTrend?.retriedPreflights >= Math.max(2, Math.ceil((providerTrend.totalPreflights || 0) / 2))) {
      warnings.push(
        `xtalpi provider-health retried ${providerTrend.retriedPreflights}/${providerTrend.totalPreflights} recent preflight(s)`,
      );
      recommendations.push("Provider is recovering after retries; consider shorter tasks or retry later if latency rises.");
    }

    if (xtalpiSmoke.result === "ATTENTION") {
      const strictFailures = xtalpiSmoke.strictTrendGate?.data?.gateFailures || [];
      if (!xtalpiSmoke.history?.ok) {
        warnings.push("xtalpi smoke history summary needs attention");
        recommendations.push(
          `Inspect xtalpi smoke history: bash ${path.join(repoRoot, "scripts", "pi67-xtalpi-pi-tools-debug-summary.sh")} --history ${xtalpiSmoke.historyLimit || 3} --json "${xtalpiSmoke.artifactDir || "$HOME/tmp/xtalpi-pi-tools-smoke"}"`,
        );
      } else if (!xtalpiSmoke.strictTrendGate?.ok || xtalpiSmoke.strictTrendGate?.data?.ok !== true) {
        warnings.push(
          strictFailures.length > 0
            ? `xtalpi smoke full-suite-strict trend needs attention: ${strictFailures.join("; ")}`
            : "xtalpi smoke full-suite-strict trend needs attention",
        );
        recommendations.push(
          `Inspect xtalpi smoke trend: bash ${path.join(repoRoot, "scripts", "pi67-xtalpi-pi-tools-debug-summary.sh")} --trend-gate ${xtalpiSmoke.strictTrendLimit || 3} --profile full-suite-strict "${xtalpiSmoke.artifactDir || "$HOME/tmp/xtalpi-pi-tools-smoke"}"`,
        );
      } else if (
        xtalpiSmoke.rankingTrendGate &&
        xtalpiSmoke.rankingTrendGate.skipped !== true &&
        (!xtalpiSmoke.rankingTrendGate.ok || xtalpiSmoke.rankingTrendGate.data?.ok !== true)
      ) {
        const rankingFailures = xtalpiSmoke.rankingTrendGate?.data?.gateFailures || [];
        warnings.push(
          rankingFailures.length > 0
            ? `xtalpi smoke full-suite-ranking-strict trend needs attention: ${rankingFailures.join("; ")}`
            : "xtalpi smoke full-suite-ranking-strict trend needs attention",
        );
        recommendations.push(
          `Inspect xtalpi smoke ranking trend: bash ${path.join(repoRoot, "scripts", "pi67-xtalpi-pi-tools-debug-summary.sh")} --trend-gate ${xtalpiSmoke.strictTrendLimit || 3} --profile full-suite-ranking-strict "${xtalpiSmoke.artifactDir || "$HOME/tmp/xtalpi-pi-tools-smoke"}"`,
        );
      } else if (xtalpiSmoke.drift && !xtalpiSmoke.drift.ok) {
        warnings.push("xtalpi smoke full-suite drift summary needs attention");
        recommendations.push(
          `Inspect xtalpi smoke drift: bash ${path.join(repoRoot, "scripts", "pi67-xtalpi-pi-tools-debug-summary.sh")} --drift ${xtalpiSmoke.driftLimit || 10} --run-kind full-suite --json "${xtalpiSmoke.artifactDir || "$HOME/tmp/xtalpi-pi-tools-smoke"}"`,
        );
      } else {
        warnings.push("xtalpi smoke status needs attention");
      }
    } else if (xtalpiSmoke.result === "UNAVAILABLE") {
      warnings.push(`xtalpi smoke status unavailable: ${(xtalpiSmoke.warnings || []).join("; ") || "unknown reason"}`);
    }
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
const installMode = deriveInstallMode();
const repository = deriveRepository();
const remote = deriveRemote(repository);
const report = deriveReport(repository, version);
const xtalpiSmoke = xtalpiSmokeEnabled
  ? collectXtalpiSmokeStatus({
      repoRoot,
      artifactDir: xtalpiSmokeDirArg || defaultArtifactDir(),
      historyLimit: xtalpiSmokeHistoryArg,
      strictTrendLimit: xtalpiSmokeTrendArg,
      driftLimit: xtalpiSmokeDriftArg,
      timeoutMs: xtalpiSmokeTimeoutMsArg,
    })
  : {
      schemaVersion: 1,
      schemaId: "pi67-xtalpi-smoke-status/v1",
      skipped: true,
      reason: "disabled by caller",
    };
const status = deriveResult(repository, remote, report, xtalpiSmoke);

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
  installMode,
  agent: {
    dir: agentDir,
    installMode,
  },
  report,
  xtalpiSmoke,
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
console.log(`Install mode: ${installMode}`);
console.log("");
console.log("--- distribution ---");
console.log(`Version    : ${version || "unknown"}`);
console.log(`Package    : ${packageVersion || "unknown"}`);
console.log(`Branch     : ${repository.branch || "unknown"}`);
console.log(`Commit     : ${repository.shortCommit || "unknown"}`);
console.log(
  `Dirty      : ${boolText(Boolean(repository.dirty))}${repository.dirty ? ` (${repository.dirtyCount} change(s))` : ""}` +
    `${repository.localState?.benignRuntimeOnly ? " [local runtime state only]" : ""}`,
);
if (repository.localState?.benignRuntimeOnly) {
  console.log(`Dirty note : ${repository.localState.benignRuntimeReasons.join("; ") || "benign local runtime state"}`);
}
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
console.log("--- xtalpi smoke ---");
if (xtalpiSmoke.skipped) {
  console.log(`State      : skipped (${xtalpiSmoke.reason || "unknown reason"})`);
} else {
  console.log(`Artifact dir: ${xtalpiSmoke.artifactDir || "unknown"}`);
  console.log(`Result     : ${xtalpiSmoke.result || "unknown"}`);
  if (!xtalpiSmoke.artifactsExist) {
    console.log("History    : no artifacts");
  } else {
    const history = xtalpiSmoke.history?.data;
    const latest = history?.runs?.[0];
    const providerTrend = xtalpiSmoke.providerHealthTrend;
    console.log(
      `History    : found=${history?.found ?? "?"}/${history?.requested ?? "?"} total=${history?.totalArtifacts ?? "?"}`,
    );
    if (providerTrend) {
      console.log(
        `Provider health: recent=${providerTrend.totalPreflights} retried=${providerTrend.retriedPreflights} ` +
          `failed=${providerTrend.failedPreflights} timeout_attempts=${providerTrend.timeoutAttempts} ` +
          `retryable_attempts=${providerTrend.retryableAttempts}`,
      );
    }
    if (latest) {
      console.log(
        `Latest     : ${latest.runId || "unknown"} run_kind=${latest.runKind || "unknown"} ` +
          `ok=${latest.ok ?? "?"} failures=${latest.failures ?? "?"} cases=${latest.cases ?? "?"} ` +
          latencyText(latest),
      );
    }
    const trend = xtalpiSmoke.strictTrendGate?.data;
    if (trend) {
      console.log(
        `Strict gate: ok=${trend.ok ?? "?"} found=${trend.found ?? "?"}/${trend.requested ?? "?"} ` +
          `eligible=${trend.candidateArtifacts ?? "?"} filtered_out=${trend.filteredOutArtifacts ?? "?"} ` +
          `run_kind_filter=${trend.filter?.runKinds?.join(",") || "(none)"} ` +
          `run_kinds=${JSON.stringify(trend.runKindCounts || {})}`,
      );
      if (trend.gateFailures?.length) {
        console.log(`Gate why   : ${trend.gateFailures.join("; ")}`);
      }
      const trendLatest = trend.runs?.[0];
      if (trendLatest) {
        console.log(
          `Gate perf  : latest=${trendLatest.runId || "unknown"} ` +
            latencyText(trendLatest),
        );
        const selectedNames = trendLatest.runtimeSelectedToolNames?.length
          ? trendLatest.runtimeSelectedToolNames.join(",")
          : "(none)";
        console.log(
          `Tool select: latest=${trendLatest.runId || "unknown"} ` +
            `selected_names=${selectedNames} ` +
            `max_tools=${trendLatest.runtimeMaxTools?.join(",") || "?"} ` +
            `valid=${trendLatest.runtimeToolSelectionValidCount?.join(",") || "?"} ` +
            `omitted=${trendLatest.runtimeToolSelectionOmittedCount?.join(",") || "?"} ` +
            `clipped=${trendLatest.runtimeToolSelectionClipped?.join(",") || "?"}`,
        );
      }
    } else if (xtalpiSmoke.strictTrendGate) {
      console.log(
        `Strict gate: unavailable exit=${xtalpiSmoke.strictTrendGate.exitCode ?? "?"} ` +
          `parse_error=${xtalpiSmoke.strictTrendGate.parseError || "none"}`,
      );
    }
    const reasonTelemetry = xtalpiSmoke.reasonCodeTelemetry || trend?.reasonCodeTelemetry;
    if (reasonTelemetry) {
      console.log(
        `Reason code: compatibility=${reasonTelemetry.compatibility || "unknown"} ` +
          `supported=${reasonTelemetry.supported === true ? "yes" : "no"} ` +
          `unsupported_runs=${reasonTelemetry.unsupportedRunIds?.join(",") || "(none)"}`,
      );
    }
    const ranking = xtalpiSmoke.rankingTrendGate?.data;
    if (ranking) {
      console.log(
        `Ranking gate: ok=${ranking.ok ?? "?"} found=${ranking.found ?? "?"}/${ranking.requested ?? "?"} ` +
          `eligible=${ranking.candidateArtifacts ?? "?"} filtered_out=${ranking.filteredOutArtifacts ?? "?"}`,
      );
      if (ranking.gateFailures?.length) {
        console.log(`Ranking why : ${ranking.gateFailures.join("; ")}`);
      }
    } else if (xtalpiSmoke.rankingTrendGate?.skipped) {
      console.log(
        `Ranking gate: skipped (${xtalpiSmoke.rankingTrendGate.reason || "unknown reason"})`,
      );
    } else if (xtalpiSmoke.rankingTrendGate) {
      console.log(
        `Ranking gate: unavailable exit=${xtalpiSmoke.rankingTrendGate.exitCode ?? "?"} ` +
          `parse_error=${xtalpiSmoke.rankingTrendGate.parseError || "none"}`,
      );
    }
    const drift = xtalpiSmoke.drift?.data;
    if (drift) {
      console.log(
        `Drift      : found=${drift.found ?? "?"}/${drift.requested ?? "?"} ` +
          `eligible=${drift.candidateArtifacts ?? "?"} filtered_out=${drift.filteredOutArtifacts ?? "?"} ` +
          `run_kind_filter=${drift.filter?.runKinds?.join(",") || "(none)"}`,
      );
      console.log(
        `Drift flags: provider_model=${drift.drift?.providerModelChanged ?? "?"} ` +
          `case_set=${drift.drift?.caseSetChanged ?? "?"} ` +
          `runtime_fingerprint=${drift.drift?.runtimeFingerprintChanged ?? "?"} ` +
          `runtime_bounds=${drift.drift?.runtimeBoundsChanged ?? "?"} ` +
          `provider_health=${drift.drift?.providerHealthChanged ?? "?"} ` +
          `quality_signals=${drift.drift?.qualitySignalsPresent ?? "?"}`,
      );
      if (drift.qualityTotals) {
        console.log(
          `Drift perf : request_latency_ms_max=${drift.qualityTotals.requestLatencyMsMax ?? "?"} ` +
            `slow_requests=${drift.qualityTotals.slowRequestCount ?? "?"}`,
        );
      }
    } else if (xtalpiSmoke.drift) {
      console.log(
        `Drift      : unavailable exit=${xtalpiSmoke.drift.exitCode ?? "?"} ` +
          `parse_error=${xtalpiSmoke.drift.parseError || "none"}`,
      );
    }
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
