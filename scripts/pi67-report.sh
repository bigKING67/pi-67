#!/usr/bin/env bash
set -euo pipefail

# Generate the local pi-67 install/update report.
# The report is a single current-state JSON file and is overwritten atomically.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI67_STATE_DIR="${PI67_STATE_DIR:-}"
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
OPERATION="manual"
OUTPUT=""
RUN_DOCTOR=true
DOCTOR_TIMEOUT_MS=90000
DOCTOR_DEEP_MCP=false
MCP_TIMEOUT_MS=2500
XTALPI_SMOKE=true
XTALPI_SMOKE_DIR="${PI67_XTALPI_SMOKE_DIR:-}"
XTALPI_SMOKE_HISTORY=3
XTALPI_SMOKE_TREND=3
XTALPI_SMOKE_DRIFT=10
XTALPI_SMOKE_TIMEOUT_MS=15000
DRY_RUN=false

usage() {
  cat <<'USAGE'
pi67-report writes the current pi-67 install/update report.

Usage:
  scripts/pi67-report.sh [options]

Options:
      --repo-root DIR       pi-67 checkout. Defaults to parent of this script.
      --agent-dir DIR       Pi agent dir. Defaults to ~/.pi/agent.
      --state-dir DIR       pi-67 state root. Derived from --agent-dir by default.
      --skills-dir DIR      Shared skill root. Defaults to ~/.agents/skills.
      --operation NAME      Report operation: install, update, manual. Defaults to manual.
      --output FILE         Output path. Defaults to ~/.pi/agent/pi67-report.json.
      --no-doctor           Do not run doctor; mark doctor as skipped.
      --doctor-timeout-ms MS
                            Timeout for doctor JSON. Defaults to 90000.
      --doctor-deep-mcp     Include doctor --deep-mcp in the report.
      --mcp-timeout-ms MS   Timeout passed to doctor --deep-mcp. Defaults to 2500.
      --no-xtalpi-smoke     Do not summarize local xtalpi smoke artifacts.
      --xtalpi-smoke-dir DIR
                            Smoke artifact dir. Defaults to ~/tmp/xtalpi-pi-tools-smoke.
      --xtalpi-smoke-history N
                            Number of newest smoke runs to summarize. Defaults to 3.
      --xtalpi-smoke-trend N
                            Number of newest smoke runs for full-suite-strict trend gate. Defaults to 3.
      --xtalpi-smoke-drift N
                            Number of newest full-suite smoke runs for drift summary. Defaults to 10.
      --xtalpi-smoke-timeout-ms MS
                            Timeout per debug-summary command. Defaults to 15000.
      --dry-run             Print the target path without writing.
  -h, --help                Show this help.

Report retention:
  pi67-report.json is overwritten on every install/update. It does not append
  historical entries, so normal usage does not create unbounded report files.
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
    --state-dir)
      PI67_STATE_DIR="${2:?--state-dir requires a path}"
      shift 2
      ;;
    --skills-dir)
      SHARED_SKILLS_DIR="${2:?--skills-dir requires a path}"
      shift 2
      ;;
    --operation)
      OPERATION="${2:?--operation requires a name}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:?--output requires a path}"
      shift 2
      ;;
    --no-doctor)
      RUN_DOCTOR=false
      shift
      ;;
    --doctor-timeout-ms)
      DOCTOR_TIMEOUT_MS="${2:?--doctor-timeout-ms requires a number}"
      shift 2
      ;;
    --doctor-deep-mcp)
      DOCTOR_DEEP_MCP=true
      shift
      ;;
    --mcp-timeout-ms)
      MCP_TIMEOUT_MS="${2:?--mcp-timeout-ms requires a number}"
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
    --dry-run)
      DRY_RUN=true
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

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to write pi67-report.json" >&2
  exit 1
fi

if [ -z "$OUTPUT" ]; then
  OUTPUT="$PI_AGENT_DIR/pi67-report.json"
fi

if [ "$DRY_RUN" = true ]; then
  echo "DRY-RUN write report: $OUTPUT"
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$PI67_STATE_DIR" "$SHARED_SKILLS_DIR" "$OPERATION" "$OUTPUT" "$RUN_DOCTOR" "$DOCTOR_TIMEOUT_MS" "$DOCTOR_DEEP_MCP" "$MCP_TIMEOUT_MS" "$XTALPI_SMOKE" "$XTALPI_SMOKE_DIR" "$XTALPI_SMOKE_HISTORY" "$XTALPI_SMOKE_TREND" "$XTALPI_SMOKE_DRIFT" "$XTALPI_SMOKE_TIMEOUT_MS" "$SCRIPT_DIR" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const [
  ,
  ,
  repoRoot,
  agentDir,
  stateDirArg,
  sharedSkillsDir,
  operation,
  output,
  runDoctorArg,
  doctorTimeoutMsArg,
  doctorDeepMcpArg,
  mcpTimeoutMs,
  xtalpiSmokeArg,
  xtalpiSmokeDirArg,
  xtalpiSmokeHistoryArg,
  xtalpiSmokeTrendArg,
  xtalpiSmokeDriftArg,
  xtalpiSmokeTimeoutMsArg,
  scriptDir,
] = process.argv;
const runDoctor = runDoctorArg === "true";
const doctorTimeoutMs = Number(doctorTimeoutMsArg || "90000");
const doctorDeepMcp = doctorDeepMcpArg === "true";
const xtalpiSmokeEnabled = xtalpiSmokeArg === "true";
const { collectXtalpiSmokeStatus, defaultArtifactDir } = require(path.join(scriptDir, "pi67-xtalpi-smoke-status-core.cjs"));

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: options.timeout || 15000,
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

function git(args) {
  return command("git", ["-C", repoRoot, ...args], { cwd: repoRoot });
}

function realPathMaybe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function pathIdentity(target) {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveStateDir(targetAgentDir) {
  const stateRoot = path.join(os.homedir(), ".pi", "pi67");
  const canonicalAgentDir = path.join(os.homedir(), ".pi", "agent");
  if (pathIdentity(targetAgentDir) === pathIdentity(canonicalAgentDir)) return stateRoot;
  const workspaceId = crypto
    .createHash("sha256")
    .update(pathIdentity(targetAgentDir))
    .digest("hex")
    .slice(0, 16);
  return path.join(stateRoot, "workspaces", workspaceId);
}

const stateDir = path.resolve(stateDirArg || resolveStateDir(agentDir));
const releasePointerPath = path.join(stateDir, "current.json");
const releasePointerCandidate = readJsonIfExists(releasePointerPath);
const canonicalAgentDir = path.join(os.homedir(), ".pi", "agent");
const releasePointer = releasePointerCandidate?.schema === "pi67.release-pointer.v1" && (
  releasePointerCandidate.agentDir
    ? realPathMaybe(releasePointerCandidate.agentDir) === realPathMaybe(agentDir)
    : realPathMaybe(canonicalAgentDir) === realPathMaybe(agentDir)
) ? releasePointerCandidate : null;
const installMode = releasePointer
  ? "immutable-release"
  : (realPathMaybe(repoRoot) === realPathMaybe(agentDir) ? "source-checkout" : "linked-source");

function commandVersion(binary, args = ["--version"]) {
  const result = command(binary, args, { cwd: repoRoot, timeout: 5000 });
  if (!result.ok && !result.stdout) return null;
  return result.stdout.split(/\r?\n/)[0] || null;
}

function gitTracks(rel) {
  if (!rel) return false;
  const result = git(["ls-files", "--", rel]);
  return result.ok && result.stdout.length > 0;
}

function gitIgnores(rel) {
  if (!rel) return false;
  const result = command("git", ["-C", repoRoot, "check-ignore", "-q", rel], { cwd: repoRoot });
  return result.status === 0;
}

function fileState(file, rel = "") {
  try {
    const stat = fs.lstatSync(file);
    const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    let classification = type;
    if (type === "symlink") {
      classification = "symlink";
    } else if (installMode === "source-checkout" && gitTracks(rel)) {
      classification = stat.isDirectory() ? "tracked_dir" : stat.isFile() ? "tracked_file" : "other";
    } else if (["models.json", "mcp.json", "auth.json", "image-gen.json"].includes(rel) && gitIgnores(rel)) {
      classification = "local_file";
    } else if (gitIgnores(rel)) {
      classification = "ignored_runtime";
    }
    return {
      exists: true,
      type,
      classification,
    };
  } catch {
    return { exists: false, type: "missing", classification: "missing" };
  }
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function runDoctorJson() {
  if (!runDoctor) {
    return {
      skipped: true,
      reason: "disabled by caller",
    };
  }

  const doctor = path.join(repoRoot, "scripts", "pi67-doctor.sh");
  if (!fs.existsSync(doctor)) {
    return {
      skipped: true,
      reason: `doctor script missing: ${doctor}`,
    };
  }

  const args = [doctor, "--repo-root", repoRoot, "--agent-dir", agentDir, "--skills-dir", sharedSkillsDir, "--json"];
  if (doctorDeepMcp) {
    args.push("--deep-mcp", "--mcp-timeout-ms", String(mcpTimeoutMs || "2500"));
  }

  const timeout = Math.max(doctorTimeoutMs, doctorDeepMcp ? 60000 : 10000);
  const result = command("bash", args, { cwd: repoRoot, timeout });
  const parsed = readJsonFromText(result.stdout);
  if (parsed) {
    return {
      skipped: false,
      exitCode: result.status,
      deepMcp: doctorDeepMcp,
      ...parsed,
    };
  }

  return {
    skipped: false,
    exitCode: result.status,
    signal: result.signal,
    error: result.error,
    deepMcp: doctorDeepMcp,
    parseError: "doctor did not emit valid JSON",
    timeoutMs: timeout,
    stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr || "", "utf8"),
  };
}

function readJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readSkillNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function sharedSkillState(settings) {
  const sourceDir = path.join(repoRoot, "shared-skills");
  const sourceSkills = readSkillNames(sourceDir);
  const installedSkills = readSkillNames(sharedSkillsDir);
  const missingInstalled = sourceSkills.filter((name) => !installedSkills.includes(name));
  const legacyAgentSkillsDir = path.join(agentDir, "skills");
  const legacyAgentSkills = readSkillNames(legacyAgentSkillsDir);
  const packageRoots = [
    path.join(agentDir, "git", "github.com", "bigKING67", "design-craft", "skills"),
    path.join(agentDir, "git", "github.com", "bigKING67", "browser67", "skills"),
  ];
  const duplicateRoots = [];

  if (legacyAgentSkills.length > 0) {
    duplicateRoots.push({
      root: legacyAgentSkillsDir,
      names: legacyAgentSkills,
      duplicateNames: intersection(legacyAgentSkills, installedSkills),
    });
  }

  for (const root of packageRoots) {
    const names = readSkillNames(root);
    if (names.length > 0) {
      duplicateRoots.push({
        root,
        names,
        duplicateNames: intersection(names, installedSkills),
      });
    }
  }

  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  const activeSkillPackageSources = packages.filter((item) => {
    const value = String(item);
    return value.includes("github.com/bigKING67/design-craft") || value.includes("github.com/bigKING67/browser67");
  });

  return {
    canonicalRoot: sharedSkillsDir,
    sourceDir,
    sourceCount: sourceSkills.length,
    installedCount: installedSkills.length,
    sourceSkills,
    installedSkills,
    missingInstalled,
    duplicateRoots,
    activeSkillPackageSources,
  };
}

function sharedSkillPackState() {
  const helper = path.join(scriptDir, "pi67-shared-skill-packs-status.mjs");
  const lockPath = path.join(repoRoot, "shared-skill-packs.lock.json");
  if (!fs.existsSync(helper)) {
    return {
      schemaId: "pi67-shared-skill-packs-status/v1",
      registry: {
        path: path.join(repoRoot, "shared-skill-packs.json"),
        exists: fs.existsSync(path.join(repoRoot, "shared-skill-packs.json")),
        valid: false,
      },
      lock: {
        path: lockPath,
        exists: fs.existsSync(lockPath),
        valid: false,
      },
      skillsDir: sharedSkillsDir,
      summary: { packs: 0, consistent: 0, attention: 1 },
      packs: [],
      errors: ["shared Skill Pack status helper is missing"],
    };
  }
  const result = command(process.execPath, [
    helper,
    "--repo-root", repoRoot,
    "--skills-dir", sharedSkillsDir,
    "--json",
  ], { cwd: repoRoot, timeout: 30000 });
  const parsed = readJsonFromText(result.stdout);
  if (parsed?.schemaId === "pi67-shared-skill-packs-status/v1") return parsed;
  return {
    schemaId: "pi67-shared-skill-packs-status/v1",
    registry: {
      path: path.join(repoRoot, "shared-skill-packs.json"),
      exists: fs.existsSync(path.join(repoRoot, "shared-skill-packs.json")),
      valid: false,
    },
    lock: {
      path: lockPath,
      exists: fs.existsSync(lockPath),
      valid: false,
    },
    skillsDir: sharedSkillsDir,
    summary: { packs: 0, consistent: 0, attention: 1 },
    packs: [],
    errors: [result.stderr || result.error || "could not parse shared Skill Pack status"],
  };
}

const version = readText(path.join(repoRoot, "VERSION")).trim() || "unknown";
const packageJson = readJsonIfExists(path.join(repoRoot, "package.json"));
const settingsJson = readJsonIfExists(path.join(agentDir, "settings.json"));
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const commit = git(["rev-parse", "HEAD"]);
const shortCommit = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
const remote = git(["remote", "get-url", "origin"]);
const sharedSkills = sharedSkillState(settingsJson);
const sharedSkillPacks = sharedSkillPackState();

const report = {
  schemaVersion: 2,
  schemaId: "pi67-report/v2",
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/pi67-report.sh",
  operation,
  pi67Version: version,
  packageVersion: packageJson?.version || null,
  pi67: {
    version,
    packageVersion: packageJson?.version || null,
    stateDir,
    release: releasePointer ? {
      version: releasePointer.version || null,
      path: releasePointer.releasePath || null,
      activatedAt: releasePointer.activatedAt || null,
    } : null,
  },
  reportPolicy: {
    currentFileOverwritten: true,
    historicalReports: false,
    retention: "single-current-file",
  },
  diagnostics: {
    doctorTimeoutMs,
    doctorDeepMcp,
    mcpTimeoutMs: Number(mcpTimeoutMs || "2500"),
  },
  installMode,
  repository: {
    root: repoRoot,
    branch: branch.ok ? branch.stdout : null,
    commit: commit.ok ? commit.stdout : null,
    shortCommit: shortCommit.ok ? shortCommit.stdout : null,
    dirty: dirty.ok ? dirty.stdout.length > 0 : null,
    remote: remote.ok ? remote.stdout : null,
  },
  sharedSkillsRoot: sharedSkillsDir,
  sharedSkills,
  sharedSkillPacks,
  externalPackages: [],
  agent: {
    dir: agentDir,
    installMode,
    reportPath: output,
    files: {
      settings: fileState(path.join(agentDir, "settings.json"), "settings.json"),
      agents: fileState(path.join(agentDir, "AGENTS.md"), "AGENTS.md"),
      rules: fileState(path.join(agentDir, "rules"), "rules"),
      prompts: fileState(path.join(agentDir, "prompts"), "prompts"),
      sharedSkillsSource: fileState(path.join(repoRoot, "shared-skills"), "shared-skills"),
      legacyAgentSkills: fileState(path.join(agentDir, "skills"), "skills"),
      scripts: fileState(path.join(agentDir, "scripts"), "scripts"),
      models: fileState(path.join(agentDir, "models.json"), "models.json"),
      mcp: fileState(path.join(agentDir, "mcp.json"), "mcp.json"),
      auth: fileState(path.join(agentDir, "auth.json"), "auth.json"),
      imageGen: fileState(path.join(agentDir, "image-gen.json"), "image-gen.json"),
      trust: fileState(path.join(agentDir, "trust.json"), "trust.json"),
      mcpCache: fileState(path.join(agentDir, "mcp-cache.json"), "mcp-cache.json"),
      runHistory: fileState(path.join(agentDir, "run-history.jsonl"), "run-history.jsonl"),
      sessions: fileState(path.join(agentDir, "sessions"), "sessions"),
      npm: fileState(path.join(agentDir, "npm"), "npm"),
      bin: fileState(path.join(agentDir, "bin"), "bin"),
      git: fileState(path.join(agentDir, "git"), "git"),
      themes: fileState(path.join(agentDir, "themes"), "themes"),
    },
  },
  runtime: {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    node: process.version,
    npm: commandVersion("npm", ["-v"]),
    piCommandAvailable: command("pi", ["--help"], { cwd: repoRoot, timeout: 5000 }).ok,
  },
  doctor: runDoctorJson(),
  xtalpiSmoke: xtalpiSmokeEnabled
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
      },
};

const dir = path.dirname(output);
const temp = path.join(dir, `.pi67-report.${process.pid}.${Date.now()}.tmp`);
fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, output);
try {
  fs.chmodSync(output, 0o600);
} catch {
  // chmod is best-effort on non-POSIX filesystems.
}

console.log(`pi67 report written: ${output}`);
NODE
