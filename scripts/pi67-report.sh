#!/usr/bin/env bash
set -euo pipefail

# Generate the local pi-67 install/update report.
# The report is a single current-state JSON file and is overwritten atomically.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
OPERATION="manual"
OUTPUT=""
RUN_DOCTOR=true
DOCTOR_TIMEOUT_MS=90000
DOCTOR_DEEP_MCP=false
MCP_TIMEOUT_MS=2500
DRY_RUN=false

usage() {
  cat <<'USAGE'
pi67-report writes the current pi-67 install/update report.

Usage:
  scripts/pi67-report.sh [options]

Options:
      --repo-root DIR       pi-67 checkout. Defaults to parent of this script.
      --agent-dir DIR       Pi agent dir. Defaults to ~/.pi/agent.
      --operation NAME      Report operation: install, update, manual. Defaults to manual.
      --output FILE         Output path. Defaults to ~/.pi/agent/pi67-report.json.
      --no-doctor           Do not run doctor; mark doctor as skipped.
      --doctor-timeout-ms MS
                            Timeout for doctor JSON. Defaults to 90000.
      --doctor-deep-mcp     Include doctor --deep-mcp in the report.
      --mcp-timeout-ms MS   Timeout passed to doctor --deep-mcp. Defaults to 2500.
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

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$OPERATION" "$OUTPUT" "$RUN_DOCTOR" "$DOCTOR_TIMEOUT_MS" "$DOCTOR_DEEP_MCP" "$MCP_TIMEOUT_MS" <<'NODE'
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const [, , repoRoot, agentDir, operation, output, runDoctorArg, doctorTimeoutMsArg, doctorDeepMcpArg, mcpTimeoutMs] = process.argv;
const runDoctor = runDoctorArg === "true";
const doctorTimeoutMs = Number(doctorTimeoutMsArg || "90000");
const doctorDeepMcp = doctorDeepMcpArg === "true";

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

const installMode = realPathMaybe(repoRoot) === realPathMaybe(agentDir) ? "in-place" : "linked";

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
    } else if (installMode === "in-place" && gitTracks(rel)) {
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

  const args = [doctor, "--repo-root", repoRoot, "--agent-dir", agentDir, "--json"];
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

function pinnedCommitFromSpec(spec) {
  const match = String(spec || "").match(/@([0-9a-f]{7,40})$/i);
  return match ? match[1] : null;
}

function packageHead(dir) {
  const result = command("git", ["-C", dir, "rev-parse", "HEAD"], { cwd: repoRoot, timeout: 5000 });
  return result.ok ? result.stdout : null;
}

function externalPackageState(settings, pkg) {
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  const sourceNeedle = `github.com/bigKING67/${pkg.repo}`;
  const source = packages.find((item) => String(item).includes(sourceNeedle)) || null;
  const cloneDir = path.join(agentDir, "git", "github.com", "bigKING67", pkg.repo);
  const exists = fs.existsSync(cloneDir);
  const missingFiles = exists
    ? pkg.files.filter((rel) => !fs.existsSync(path.join(cloneDir, rel)))
    : pkg.files.slice();
  const head = exists ? packageHead(cloneDir) : null;

  return {
    name: pkg.name,
    source,
    declared: Boolean(source),
    pinnedCommit: pinnedCommitFromSpec(source),
    installPath: cloneDir,
    installed: exists,
    headCommit: head,
    expectedFiles: pkg.files,
    missingFiles,
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
const externalPackageSpecs = [
  {
    name: "design-craft",
    repo: "design-craft",
    files: [
      "package.json",
      "skills/design-craft/SKILL.md",
      "skills/frontend-craft/SKILL.md",
    ],
  },
  {
    name: "browser67",
    repo: "browser67",
    files: [
      "package.json",
      "skills/browser67/SKILL.md",
      "skills/tmwd-browser-mcp/SKILL.md",
      "skills/js-reverse/SKILL.md",
      "src/mcp/browser/server.mjs",
      "src/mcp/js-reverse/server.mjs",
    ],
  },
];

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
  externalPackages: externalPackageSpecs.map((pkg) => externalPackageState(settingsJson, pkg)),
  agent: {
    dir: agentDir,
    installMode,
    reportPath: output,
    files: {
      settings: fileState(path.join(agentDir, "settings.json"), "settings.json"),
      agents: fileState(path.join(agentDir, "AGENTS.md"), "AGENTS.md"),
      rules: fileState(path.join(agentDir, "rules"), "rules"),
      prompts: fileState(path.join(agentDir, "prompts"), "prompts"),
      skills: fileState(path.join(agentDir, "skills"), "skills"),
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
    pi: commandVersion("pi", ["--version"]),
  },
  doctor: runDoctorJson(),
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
