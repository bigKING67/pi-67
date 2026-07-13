#!/usr/bin/env bash
set -u

# pi-67 readiness diagnostics.
# The full configuration is always installed; this script reports which
# capabilities are ready and which need local keys, paths, or binaries.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
RUN_PI_LIST=true
OUTPUT_FORMAT="text"
QUIET=false
DEEP_MCP=false
MCP_TIMEOUT_MS=2500
PI_LIST_TIMEOUT_SECONDS="${PI67_DOCTOR_PI_LIST_TIMEOUT_SECONDS:-${PI67_DOCTOR_SKILL_LIST_TIMEOUT_SECONDS:-60}}"
STRICT_SHARED_SKILLS=false

CHECKS_FILE="$(mktemp "${TMPDIR:-/tmp}/pi67-doctor-checks.XXXXXX")"

cleanup() {
  rm -f "$CHECKS_FILE"
}
trap cleanup EXIT

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
UPSTREAM_PI_JSON="null"

usage() {
  cat <<'USAGE'
pi67-doctor checks whether the full pi-67 installation is ready.

Usage:
  scripts/pi67-doctor.sh [options]

Options:
      --repo-root DIR      Repository root. Defaults to parent of this script.
      --agent-dir DIR      Pi agent dir. Defaults to ~/.pi/agent.
      --skills-dir DIR     Shared skill root. Defaults to ~/.agents/skills.
      --no-pi-list         Skip the non-interactive `pi list --no-approve` package probe.
      --no-skill-list      Deprecated alias for --no-pi-list.
      --strict-shared-skills
                           Treat global shared skills that differ from the
                           pi-67 bundled baseline as FAIL instead of WARN.
      --deep-mcp           Start configured MCP servers briefly and probe initialize + tools/list.
      --mcp-timeout-ms MS  Timeout per MCP deep probe. Defaults to 2500.
      --pi-list-timeout-seconds SEC
                           Timeout for `pi list --no-approve`. Defaults to 60.
      --skill-list-timeout-seconds SEC
                           Deprecated alias for --pi-list-timeout-seconds.
      --quiet              Print only the text summary and final result.
      --json               Print machine-readable JSON only.
  -h, --help               Show this help.
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
    --skills-dir)
      SHARED_SKILLS_DIR="${2:?--skills-dir requires a path}"
      shift 2
      ;;
    --no-pi-list|--no-skill-list)
      RUN_PI_LIST=false
      shift
      ;;
    --strict-shared-skills)
      STRICT_SHARED_SKILLS=true
      shift
      ;;
    --deep-mcp)
      DEEP_MCP=true
      shift
      ;;
    --mcp-timeout-ms)
      MCP_TIMEOUT_MS="${2:?--mcp-timeout-ms requires a number}"
      shift 2
      ;;
    --pi-list-timeout-seconds|--skill-list-timeout-seconds)
      PI_LIST_TIMEOUT_SECONDS="${2:?$1 requires a number}"
      shift 2
      ;;
    --quiet)
      QUIET=true
      shift
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

if ! [[ "$MCP_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$MCP_TIMEOUT_MS" -lt 250 ]; then
  echo "--mcp-timeout-ms must be an integer >= 250" >&2
  exit 2
fi

if ! [[ "$PI_LIST_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$PI_LIST_TIMEOUT_SECONDS" -lt 1 ]; then
  echo "--pi-list-timeout-seconds must be an integer >= 1" >&2
  exit 2
fi

detailed_text_enabled() {
  [ "$OUTPUT_FORMAT" = "text" ] && [ "$QUIET" != true ]
}

record_check() {
  local level="$1"
  shift
  printf '%s\t%s\n' "$level" "$*" >> "$CHECKS_FILE"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  record_check "PASS" "$*"
  if detailed_text_enabled; then
    echo -e "  ${GREEN}PASS${NC} $*"
  fi
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  record_check "WARN" "$*"
  if detailed_text_enabled; then
    echo -e "  ${YELLOW}WARN${NC} $*"
  fi
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  record_check "FAIL" "$*"
  if detailed_text_enabled; then
    echo -e "  ${RED}FAIL${NC} $*"
  fi
}

section() {
  if detailed_text_enabled; then
    echo ""
    echo -e "${CYAN}--- $* ---${NC}"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'
}

emit_json() {
  local result="$1"
  local first=true
  local generated_at
  local pi67_version

  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  pi67_version="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || printf 'unknown')"

  printf '{\n'
  printf '  "schemaVersion": 2,\n'
  printf '  "schemaId": "pi67-doctor/v2",\n'
  printf '  "generatedAt": "%s",\n' "$(json_escape "$generated_at")"
  printf '  "generatedBy": "scripts/pi67-doctor.sh",\n'
  printf '  "pi67": {\n'
  printf '    "version": "%s"\n' "$(json_escape "$pi67_version")"
  printf '  },\n'
  printf '  "upstreamPi": %s,\n' "${UPSTREAM_PI_JSON:-null}"
  printf '  "diagnostics": {\n'
  printf '    "deepMcp": %s,\n' "$DEEP_MCP"
  printf '    "mcpTimeoutMs": %s,\n' "$MCP_TIMEOUT_MS"
  printf '    "piList": %s,\n' "$RUN_PI_LIST"
  printf '    "piListTimeoutSeconds": %s,\n' "$PI_LIST_TIMEOUT_SECONDS"
  printf '    "skillList": %s,\n' "$RUN_PI_LIST"
  printf '    "skillListTimeoutSeconds": %s\n' "$PI_LIST_TIMEOUT_SECONDS"
  printf '  },\n'
  printf '  "installMode": "%s",\n' "$(json_escape "$INSTALL_MODE")"
  printf '  "repository": "%s",\n' "$(json_escape "$REPO_ROOT")"
  printf '  "agentDir": "%s",\n' "$(json_escape "$PI_AGENT_DIR")"
  printf '  "agent": {\n'
  printf '    "dir": "%s",\n' "$(json_escape "$PI_AGENT_DIR")"
  printf '    "installMode": "%s"\n' "$(json_escape "$INSTALL_MODE")"
  printf '  },\n'
  printf '  "result": "%s",\n' "$(json_escape "$result")"
  printf '  "counts": {\n'
  printf '    "pass": %s,\n' "$PASS_COUNT"
  printf '    "warn": %s,\n' "$WARN_COUNT"
  printf '    "fail": %s\n' "$FAIL_COUNT"
  printf '  },\n'
  printf '  "checks": [\n'
  while IFS=$'\t' read -r level message; do
    [ -n "$level" ] || continue
    if [ "$first" = true ]; then
      first=false
    else
      printf ',\n'
    fi
    printf '    {"level": "%s", "message": "%s"}' "$(json_escape "$level")" "$(json_escape "$message")"
  done < "$CHECKS_FILE"
  printf '\n'
  printf '  ]\n'
  printf '}\n'
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

real_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    (cd "$dir" && pwd -P)
  else
    printf '%s\n' "$dir"
  fi
}

detect_install_mode() {
  local repo_real agent_real
  repo_real="$(real_dir "$REPO_ROOT")"
  agent_real="$(real_dir "$PI_AGENT_DIR")"
  if [ "$repo_real" = "$agent_real" ]; then
    printf 'in-place\n'
  else
    printf 'linked\n'
  fi
}

git_tracks_path() {
  local rel="$1"
  git -C "$REPO_ROOT" ls-files -- "$rel" 2>/dev/null | grep -q .
}

json_valid() {
  local file="$1"
  if [ ! -f "$file" ]; then
    fail "missing JSON file: $file"
    return
  fi

  if ! command_exists node; then
    fail "node is required to validate JSON: $file"
    return
  fi

  if node "$REPO_ROOT/scripts/pi67-json-utils.cjs" --read "$file" >/dev/null 2>&1; then
    pass "valid JSON: $file"
  else
    fail "invalid JSON: $file"
  fi
}

placeholder_check() {
  local file="$1"
  if [ ! -f "$file" ]; then
    fail "missing config file: $file"
    return
  fi

  if grep -E 'YOUR_|REPLACE_ME|<[^>]+_KEY>' "$file" >/dev/null 2>&1; then
    warn "placeholder values remain in $file"
  else
    pass "no obvious placeholders in $file"
  fi
}

check_asset() {
  local rel="$1"
  local required="${2:-required}"
  local local_mode="${3:-symlink-preferred}"
  local source="$REPO_ROOT/$rel"
  local target="$PI_AGENT_DIR/$rel"
  local asset_type

  if [ ! -e "$source" ]; then
    if [ "$required" = "optional" ]; then
      warn "optional repo asset missing: $rel"
    else
      fail "repo asset missing: $rel"
    fi
    return
  fi

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    fail "not installed: $target"
    return
  fi

  if [ "$INSTALL_MODE" = "in-place" ]; then
    if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      fail "in-place mode requires a Git checkout: $REPO_ROOT"
      return
    fi

    if ! git_tracks_path "$rel"; then
      fail "in-place asset exists but is not tracked by Git: $rel"
      return
    fi

    if [ -L "$target" ]; then
      warn "in-place asset is a symlink, expected tracked file/dir: $target"
      return
    fi

    if [ -d "$target" ]; then
      asset_type="dir"
    else
      asset_type="file"
    fi
    pass "installed tracked $asset_type: $rel"
    return
  fi

  if [ -L "$target" ]; then
    pass "installed link: $rel -> $(readlink "$target")"
  elif [ "$local_mode" = "local-ok" ]; then
    pass "installed local file: $rel"
  else
    warn "installed but not a symlink: $target"
  fi
}

INSTALL_MODE="$(detect_install_mode)"

count_files() {
  local dir="$1"
  local pattern="$2"
  if [ ! -d "$dir" ]; then
    printf '0\n'
    return
  fi
  find -H "$dir" -maxdepth 1 -type f -name "$pattern" 2>/dev/null | wc -l | tr -d ' '
}

count_dirs() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    printf '0\n'
    return
  fi
  find -H "$dir" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) 2>/dev/null | wc -l | tr -d ' '
}

check_prompt_placeholders() {
  local paths=("$PI_AGENT_DIR/prompts" "$PI_AGENT_DIR/AGENTS.md")
  if command_exists rg; then
    if rg -n '\{\{[^}]+\}\}' "${paths[@]}" >/dev/null 2>&1; then
      fail "legacy double-brace prompt placeholders found in prompts/AGENTS"
    else
      pass "no legacy double-brace placeholders in prompts/AGENTS"
    fi
  else
    if grep -R '{{' "${paths[@]}" >/dev/null 2>&1; then
      fail "possible legacy double-brace placeholders found in prompts/AGENTS"
    else
      pass "no obvious double-brace placeholders in prompts/AGENTS"
    fi
  fi
}

run_node_report() {
  local script="$1"
  shift
  local args=("$@")
  if [ "${#args[@]}" -eq 0 ]; then
    args=("$REPO_ROOT" "$PI_AGENT_DIR")
  fi
  if ! command_exists node; then
    fail "node is required for this check"
    return
  fi

  while IFS='|' read -r level message; do
    case "$level" in
      PASS) pass "$message" ;;
      WARN) warn "$message" ;;
      FAIL) fail "$message" ;;
      "") ;;
      *) warn "$level|$message" ;;
    esac
  done < <(node "$script" "${args[@]}")
}

check_until_done_runtime_queue() {
  local checker="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs"
  local tmp
  if [ ! -f "$checker" ]; then
    warn "pi-until-done runtime queue checker missing"
    return
  fi
  if ! command_exists node; then
    warn "node not found; skipped pi-until-done runtime queue/progress compatibility check"
    return
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/pi67-until-done-queue.XXXXXX")"
  if node "$checker" --check --agent-dir "$PI_AGENT_DIR" --json >"$tmp" 2>/dev/null; then
    node - "$tmp" <<'NODE'
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.status === "missing") {
  console.log(`WARN|${data.message}`);
} else {
  console.log(`PASS|${data.message}`);
}
NODE
  else
    node - "$tmp" <<'NODE'
const fs = require("fs");
let data = null;
try { data = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}
if (data?.status === "review_required") {
  console.log(`WARN|${data.message}`);
} else {
  console.log(`FAIL|${data?.message || "pi-until-done runtime queue/progress compatibility check failed"}`);
}
NODE
  fi | while IFS='|' read -r level message; do
    case "$level" in
      PASS) pass "$message" ;;
      WARN) warn "$message" ;;
      FAIL) fail "$message" ;;
      *) warn "$level|$message" ;;
    esac
  done
  rm -f "$tmp"
}

run_pi_list_with_timeout() {
  local output_file="$1"
  local timeout_seconds="$2"
  node - "$output_file" "$timeout_seconds" <<'NODE'
const fs = require("fs");
const { spawn } = require("child_process");

const [outputFile, timeoutSecondsRaw] = process.argv.slice(2);
const timeoutMs = Math.max(1, Number(timeoutSecondsRaw) || 30) * 1000;
let stdout = "";
let stderr = "";
let timedOut = false;

const child = spawn("pi", ["list", "--no-approve"], {
  stdio: ["ignore", "pipe", "pipe"],
});

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1500).unref?.();
}, timeoutMs);

child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.on("error", (error) => {
  clearTimeout(timer);
  fs.writeFileSync(outputFile, `${stdout}${stderr}${error.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  clearTimeout(timer);
  fs.writeFileSync(outputFile, `${stdout}${stderr}`);
  if (timedOut) process.exit(124);
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
NODE
}

check_provider_model() {
  local checker="$REPO_ROOT/scripts/pi67-provider-status.mjs"
  if [ ! -f "$checker" ]; then
    fail "provider status checker missing: $checker"
    return
  fi
  if ! command_exists node; then
    fail "node is required for provider readiness checks"
    return
  fi

  while IFS='|' read -r level message; do
    case "$level" in
      PASS) pass "$message" ;;
      WARN) warn "$message" ;;
      FAIL) fail "$message" ;;
      "") ;;
      *) warn "$level|$message" ;;
    esac
  done < <(node "$checker" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR")

  check_vision_provider
}

check_vision_provider() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'NODE'
const path = require("path");
const [, , repoRoot, agentDir] = process.argv;
const { readJsonFile } = require(path.join(repoRoot, "scripts", "pi67-json-utils.cjs"));

function emit(level, message) {
  console.log(`${level}|${message}`);
}

let models;
try {
  models = readJsonFile(path.join(agentDir, "models.json"));
} catch (error) {
  emit("FAIL", `cannot inspect vision provider: ${error.message}`);
  process.exit(0);
}

const codexProvider = models.providers?.codex;
if (!codexProvider) {
  emit("WARN", "vision_read default provider codex is missing from models.json");
  process.exit(0);
}
const codexModels = Array.isArray(codexProvider.models) ? codexProvider.models : [];
const imageModel = codexModels.find((item) => Array.isArray(item.input) && item.input.map(String).includes("image"));
if (imageModel?.id) emit("PASS", `vision_read default image model exists under codex: ${imageModel.id}`);
else emit("WARN", "vision_read default provider codex has no image-input model");
const apiKey = String(codexProvider.apiKey || "");
if (!apiKey || /YOUR_|REPLACE_|placeholder|changeme/i.test(apiKey)) {
  emit("WARN", "vision_read codex apiKey is missing or placeholder");
} else {
  emit("PASS", "vision_read codex apiKey is configured");
}
NODE
  run_node_report "$tmp"
  rm -f "$tmp"
}

check_shared_skills() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const [, , repoRoot, agentDir, sharedSkillsDir, strictSharedSkillsRaw] = process.argv;
const { readJsonFile } = require(path.join(repoRoot, "scripts", "pi67-json-utils.cjs"));
const strictSharedSkills = strictSharedSkillsRaw === "true";

function emit(level, message) {
  console.log(`${level}|${message}`);
}

function readJson(file) {
  try {
    return readJsonFile(file);
  } catch (error) {
    emit("FAIL", `cannot read JSON ${file}: ${error.message}`);
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

function collectFileHashes(dir, base = dir, output = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFileHashes(full, base, output);
    } else if (stat.isFile()) {
      const relative = path.relative(base, full).split(path.sep).join("/");
      const fileHash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      output.push(`${relative}\0${fileHash}`);
    }
  }
  return output;
}

function skillDirFingerprint(dir) {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  const hash = crypto.createHash("sha256");
  for (const item of collectFileHashes(dir)) {
    hash.update(item);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const settings = readJson(path.join(agentDir, "settings.json"));
if (!settings) process.exit(0);

if (!Array.isArray(settings.packages)) {
  emit("FAIL", "settings.json packages must be an array");
  process.exit(0);
}

const bannedSkillPackageSources = [
  "github.com/bigKING67/design-craft",
  "github.com/bigKING67/browser67",
];
for (const sourceNeedle of bannedSkillPackageSources) {
  const spec = settings.packages.find((item) => String(item).includes(sourceNeedle));
  if (spec) {
    emit("FAIL", `settings.json still declares active skill package source: ${spec}`);
  }
}

const sourceDir = path.join(repoRoot, "shared-skills");
const sourceSkills = readSkillNames(sourceDir);
const sharedSkills = readSkillNames(sharedSkillsDir);

if (sourceSkills.length === 0) {
  emit("FAIL", `shared skill source has no skills: ${sourceDir}`);
} else {
  emit("PASS", `shared skill source available: ${sourceSkills.length} skills`);
}

if (sharedSkills.length === 0) {
  emit("FAIL", `shared skill root has no installed skills: ${sharedSkillsDir}`);
} else {
  emit("PASS", `shared skill root available: ${sharedSkillsDir} (${sharedSkills.length} skills)`);
}

const missing = sourceSkills.filter((name) => !sharedSkills.includes(name));
if (missing.length > 0) {
  emit("FAIL", `shared skills not installed in ${sharedSkillsDir}: ${missing.join(", ")}`);
} else if (sourceSkills.length > 0) {
  emit("PASS", "all pi-67 shared skills are installed in the shared skill root");
}

const mismatched = sourceSkills
  .filter((name) => sharedSkills.includes(name))
  .filter((name) => {
    const sourceHash = skillDirFingerprint(path.join(sourceDir, name));
    const installedHash = skillDirFingerprint(path.join(sharedSkillsDir, name));
    return sourceHash !== installedHash;
  });
if (mismatched.length > 0) {
  const inventoryHint = `run scripts/pi67-shared-skills-inventory.sh --json for details`;
  const message = `preserved user-modified global skills differ from pi-67 source; ${inventoryHint}; keeping existing global skills: ${mismatched.join(", ")}`;
  emit(
    strictSharedSkills ? "FAIL" : "WARN",
    strictSharedSkills
      ? `preserved user-modified global skills differ from pi-67 source; ${inventoryHint}: ${mismatched.join(", ")}`
      : message
  );
} else if (sourceSkills.length > 0 && missing.length === 0) {
  emit("PASS", "all pi-67 shared skill contents match the shared skill root");
}

const legacyAgentSkills = readSkillNames(path.join(agentDir, "skills"));
if (legacyAgentSkills.length > 0) {
  const duplicates = intersection(legacyAgentSkills, sharedSkills);
  if (duplicates.length > 0) {
    emit("WARN", `legacy ${path.join(agentDir, "skills")} duplicates shared skills: ${duplicates.join(", ")}`);
  } else {
    emit("WARN", `legacy ${path.join(agentDir, "skills")} still exists with ${legacyAgentSkills.length} skills; ~/.agents/skills is canonical`);
  }
} else {
  emit("PASS", "no legacy active skill directory under ~/.pi/agent/skills");
}

const packageSkillRoots = [
  path.join(agentDir, "git", "github.com", "bigKING67", "design-craft", "skills"),
  path.join(agentDir, "git", "github.com", "bigKING67", "browser67", "skills"),
];
for (const root of packageSkillRoots) {
  const packageSkills = readSkillNames(root);
  if (packageSkills.length === 0) continue;
  const duplicates = intersection(packageSkills, sharedSkills);
  if (duplicates.length > 0) {
    emit("WARN", `package skill cache duplicates shared skills and should not be active: ${root} (${duplicates.join(", ")})`);
  }
}
NODE
  run_node_report "$tmp" "$REPO_ROOT" "$PI_AGENT_DIR" "$SHARED_SKILLS_DIR" "$STRICT_SHARED_SKILLS"
  rm -f "$tmp"
}

check_mcp() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");
const [, , repoRoot, agentDir] = process.argv;
const { readJsonFile } = require(path.join(repoRoot, "scripts", "pi67-json-utils.cjs"));
const {
  adapterRuntimeIssues,
  commandExistsForAdapter,
  isUrl,
  resolvePathArgForAdapter,
} = require(path.join(repoRoot, "scripts", "pi67-mcp-config-utils.cjs"));
const home = process.env.HOME || "";

function emit(level, message) {
  console.log(`${level}|${message}`);
}

const file = path.join(agentDir, "mcp.json");
let config;
try {
  config = readJsonFile(file);
} catch (error) {
  emit("FAIL", `cannot read mcp.json: ${error.message}`);
  process.exit(0);
}

const servers = config.mcpServers || {};
const names = Object.keys(servers);
if (names.length === 0) {
  emit("WARN", "mcp.json has no mcpServers");
}

for (const name of names) {
  const server = servers[name] || {};
  const issues = adapterRuntimeIssues({ mcpServers: { [name]: server } }, { agentDir, home });
  for (const issue of issues) {
    emit("WARN", `MCP ${name} ${issue.field} uses unsupported runtime placeholder for pi-mcp-adapter: ${issue.value}`);
  }

  const commandState = commandExistsForAdapter(server.command, server, { agentDir, home });
  if (commandState.exists) {
    emit("PASS", `MCP ${name} command is available: ${commandState.label}`);
  } else if (commandState.unsupported) {
    emit("WARN", `MCP ${name} command cannot run until placeholder is normalized: ${commandState.label}`);
  } else {
    emit("WARN", `MCP ${name} command is not available yet: ${commandState.label}`);
  }

  for (const arg of server.args || []) {
    if (isUrl(arg)) continue;
    const resolved = resolvePathArgForAdapter(arg, server, { agentDir, home });
    if (!resolved.checkable) continue;
    if (resolved.unsupported) {
      emit("WARN", `MCP ${name} path cannot run until placeholder is normalized: ${resolved.path}`);
    } else if (fs.existsSync(resolved.path)) {
      emit("PASS", `MCP ${name} path exists: ${resolved.path}`);
    } else {
      emit("WARN", `MCP ${name} path missing or needs local edit: ${resolved.path}`);
    }
  }
}
NODE
  run_node_report "$tmp"
  rm -f "$tmp"
}

check_mcp_deep() {
  local tmp
  local out
  tmp="$(mktemp)"
  out="$(mktemp)"
  cat > "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const [, , repoRoot, agentDir, timeoutArg] = process.argv;
const { readJsonFile } = require(path.join(repoRoot, "scripts", "pi67-json-utils.cjs"));
const {
  adapterInterpolateEnvVars,
  adapterRuntimeIssues,
  commandExistsForAdapter,
  isUrl,
  resolveAdapterCwd,
  resolvePathArgForAdapter,
} = require(path.join(repoRoot, "scripts", "pi67-mcp-config-utils.cjs"));
const timeoutMs = Number(timeoutArg) || 2500;

function emit(level, message) {
  console.log(`${level}|${message}`);
}

function pathArgsMissing(server) {
  return (server.args || [])
    .map((arg) => resolvePathArgForAdapter(arg, server, { agentDir }))
    .filter((item) => item.checkable && !item.unsupported)
    .map((item) => item.path)
    .filter((arg) => !isUrl(arg) && !fs.existsSync(arg));
}

function usesNewlineJsonRpc(server) {
  const command = server.command || "";
  const args = server.args || [];
  const cwd = resolveAdapterCwd(server.cwd, agentDir);
  const text = [command, cwd, ...args].join(" ");
  return /browser67|tmwd-browser-mcp|agent-memory|agent_memory|everos|src\/mcp\/browser\/server\.mjs|src\/mcp\/js-reverse\/server\.mjs|src\/server\.mjs|src\/js-reverse-server\.mjs/.test(text);
}

function encodeMessage(message, framing = "content-length") {
  const body = JSON.stringify(message);
  if (framing === "newline") {
    return `${body}\n`;
  }
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readDistributionVersion() {
  try {
    return fs.readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  const separator = Buffer.from("\r\n\r\n");

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf(separator);
      if (headerEnd >= 0) {
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + separator.length);
          continue;
        }

        const length = Number(match[1]);
        const bodyStart = headerEnd + separator.length;
        const total = bodyStart + length;
        if (buffer.length < total) break;

        const body = buffer.subarray(bodyStart, total).toString("utf8");
        buffer = buffer.subarray(total);
        try {
          onMessage(JSON.parse(body));
        } catch {
          // Protocol-invalid stdout is ignored; the timeout/exit path reports the probe failure.
        }
        continue;
      }

      const newline = buffer.indexOf(10);
      if (newline >= 0) {
        const line = buffer.subarray(0, newline + 1).toString("utf8").trim();
        buffer = buffer.subarray(newline + 1);
        if (line.startsWith("{")) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            // Ignore non-protocol log lines on stdout.
          }
        }
        continue;
      }

      break;
    }
  };
}

function waitForResponse(child, waiters, id, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish({ type: "timeout" }), timeout);
    const onExit = (code, signal) => finish({ type: "exit", code, signal });
    const onError = (error) => finish({ type: "error", error });

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      waiters.delete(id);
      resolve(result);
    }

    waiters.set(id, (message) => finish({ type: "message", message }));
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 150).unref();
}

async function probeServer(name, server) {
  if (server.url) {
    emit("WARN", `MCP ${name} deep probe skipped: non-stdio URL transports are not supported yet`);
    return;
  }

  const runtimeIssues = adapterRuntimeIssues({ mcpServers: { [name]: server } }, { agentDir });
  if (runtimeIssues.length > 0) {
    const issue = runtimeIssues[0];
    emit("FAIL", `MCP ${name} deep probe blocked: ${issue.field} uses unsupported runtime placeholder for pi-mcp-adapter: ${issue.value}`);
    return;
  }

  const commandState = commandExistsForAdapter(server.command, server, { agentDir });
  if (!commandState.exists) {
    emit("WARN", `MCP ${name} deep probe skipped: command unavailable (${commandState.label})`);
    return;
  }

  const missing = pathArgsMissing(server);
  if (missing.length > 0) {
    emit("WARN", `MCP ${name} deep probe skipped: missing path ${missing[0]}`);
    return;
  }

  const command = server.command || "";
  const args = server.args || [];
  const env = { ...process.env };
  for (const [key, value] of Object.entries(server.env || {})) {
    env[key] = adapterInterpolateEnvVars(value);
  }
  const cwd = resolveAdapterCwd(server.cwd, agentDir);

  const waiters = new Map();
  let stderrBytes = 0;
  let child;
  const framing = usesNewlineJsonRpc(server) ? "newline" : "content-length";

  try {
    child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    emit("WARN", `MCP ${name} deep probe failed to start: ${error.message}`);
    return;
  }

  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });

  child.stdout.on("data", createParser((message) => {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const waiter = waiters.get(message.id);
      if (waiter) waiter(message);
    }
  }));

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "pi67-doctor",
        version: readDistributionVersion(),
      },
    },
  };

  const initializeWait = waitForResponse(child, waiters, 1, timeoutMs);
  child.stdin.write(encodeMessage(initialize, framing));
  const initializeResult = await initializeWait;

  if (initializeResult.type !== "message") {
    const detail = initializeResult.type === "exit"
      ? `process exited code=${initializeResult.code ?? "null"} signal=${initializeResult.signal ?? "null"}`
      : initializeResult.type;
    const stderrNote = stderrBytes > 0 ? "; stderr was produced" : "";
    emit("WARN", `MCP ${name} deep initialize did not complete: ${detail}${stderrNote}`);
    stopChild(child);
    return;
  }

  const initMessage = initializeResult.message;
  if (initMessage.error) {
    emit("WARN", `MCP ${name} deep initialize returned JSON-RPC error`);
    stopChild(child);
    return;
  }

  emit("PASS", `MCP ${name} deep initialize succeeded`);

  child.stdin.write(encodeMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, framing));

  const toolsList = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };

  const toolsWait = waitForResponse(child, waiters, 2, timeoutMs);
  child.stdin.write(encodeMessage(toolsList, framing));
  const toolsResult = await toolsWait;

  if (toolsResult.type !== "message") {
    const detail = toolsResult.type === "exit"
      ? `process exited code=${toolsResult.code ?? "null"} signal=${toolsResult.signal ?? "null"}`
      : toolsResult.type;
    emit("WARN", `MCP ${name} deep tools/list did not complete: ${detail}`);
    stopChild(child);
    return;
  }

  const toolsMessage = toolsResult.message;
  if (toolsMessage.error) {
    emit("WARN", `MCP ${name} deep tools/list returned JSON-RPC error`);
    stopChild(child);
    return;
  }

  const tools = Array.isArray(toolsMessage.result?.tools) ? toolsMessage.result.tools : [];
  if (tools.length > 0) {
    emit("PASS", `MCP ${name} deep tools/list succeeded: ${tools.length} tools`);
  } else {
    emit("WARN", `MCP ${name} deep tools/list returned no tools`);
  }

  stopChild(child);
}

async function main() {
  const file = path.join(agentDir, "mcp.json");
  let config;
  try {
    config = readJsonFile(file);
  } catch (error) {
    emit("FAIL", `cannot read mcp.json for deep probe: ${error.message}`);
    return;
  }

  const servers = config.mcpServers || {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    emit("WARN", "deep MCP probe skipped: mcp.json has no mcpServers");
    return;
  }

  for (const name of names) {
    await probeServer(name, servers[name] || {});
  }
}

main().catch((error) => {
  emit("WARN", `deep MCP probe runner failed: ${error.message}`);
});
NODE

  if ! node "$tmp" "$REPO_ROOT" "$PI_AGENT_DIR" "$MCP_TIMEOUT_MS" > "$out" 2>/dev/null; then
    warn "deep MCP probe runner failed"
  fi

  while IFS='|' read -r level message; do
    case "$level" in
      PASS) pass "$message" ;;
      WARN) warn "$message" ;;
      FAIL) fail "$message" ;;
      "") ;;
      *) warn "$level|$message" ;;
    esac
  done < "$out"

  rm -f "$tmp" "$out"
}

check_repo_secret_scan() {
  local pattern='BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+'
  local paths=(
    "$REPO_ROOT/AGENTS.md"
    "$REPO_ROOT/README.md"
    "$REPO_ROOT/docs"
    "$REPO_ROOT/extensions"
    "$REPO_ROOT/prompts"
    "$REPO_ROOT/rules"
    "$REPO_ROOT/scripts"
    "$REPO_ROOT/install.sh"
    "$REPO_ROOT/.github"
    "$REPO_ROOT/settings.json"
    "$REPO_ROOT/models.example.json"
    "$REPO_ROOT/mcp.example.json"
    "$REPO_ROOT/auth.example.json"
    "$REPO_ROOT/image-gen.example.json"
    "$REPO_ROOT/package.json"
  )

  if command_exists rg; then
    if rg -n "$pattern" "${paths[@]}" >/dev/null 2>&1; then
      fail "possible real secret pattern found in tracked repo files"
    else
      pass "repo secret pattern scan found no obvious private keys/API tokens"
    fi
    return
  fi

  if grep -R -n -E "$pattern" "${paths[@]}" >/dev/null 2>&1; then
    fail "possible real secret pattern found in tracked repo files"
  else
    pass "repo secret pattern scan found no obvious private keys/API tokens"
  fi
}

if detailed_text_enabled; then
  echo ""
  echo -e "${CYAN}pi-67 doctor${NC}"
  echo "Repository : $REPO_ROOT"
  echo "Agent dir  : $PI_AGENT_DIR"
  echo "Mode       : $INSTALL_MODE"
fi

section "Core tools"
upstream_pi_status="$REPO_ROOT/scripts/pi67-upstream-pi-status.mjs"
if command_exists node && [ -f "$upstream_pi_status" ]; then
  if UPSTREAM_PI_JSON="$(node "$upstream_pi_status" \
    --repo-root "$REPO_ROOT" \
    --agent-dir "$PI_AGENT_DIR" \
    --skills-dir "$SHARED_SKILLS_DIR" \
    --json \
    --no-remote 2>/dev/null)"; then
    run_node_report "$upstream_pi_status" \
      --repo-root "$REPO_ROOT" \
      --agent-dir "$PI_AGENT_DIR" \
      --skills-dir "$SHARED_SKILLS_DIR" \
      --check \
      --no-remote
  else
    UPSTREAM_PI_JSON="null"
    warn "could not inspect upstream Pi release compatibility"
  fi
elif command_exists pi; then
  warn "upstream Pi compatibility checker missing; pi found: $(pi --version 2>/dev/null || echo unknown)"
else
  fail "pi command not found"
fi

if command_exists node; then
  pass "node found: $(node -v 2>/dev/null || echo unknown)"
else
  fail "node command not found"
fi

if command_exists npm; then
  pass "npm found: $(npm -v 2>/dev/null || echo unknown)"
else
  warn "npm command not found; package installation may be incomplete"
fi

section "Installed full assets"
check_asset "settings.json" "required" "local-ok"
check_asset "AGENTS.md"
check_asset "extensions"
check_asset "docs"
check_asset "prompts"
check_asset "rules"
check_asset "scripts"
check_asset "templates"

rules_count="$(count_files "$PI_AGENT_DIR/rules" '*.md')"
if [ "$rules_count" -ge 8 ]; then
  pass "rules available: $rules_count"
else
  fail "expected at least 8 rules, found $rules_count"
fi

prompts_count="$(count_files "$PI_AGENT_DIR/prompts" '*.md')"
if [ "$prompts_count" -ge 5 ]; then
  pass "prompts available: $prompts_count"
else
  fail "expected at least 5 prompts, found $prompts_count"
fi

shared_source_count="$(count_dirs "$REPO_ROOT/shared-skills")"
if [ "$shared_source_count" -ge 20 ]; then
  pass "shared skill source directories available: $shared_source_count"
else
  warn "shared skill source directories look low: $shared_source_count"
fi

if [ -f "$PI_AGENT_DIR/extensions/pi-rules-loader/index.ts" ]; then
  pass "pi-rules-loader installed"
else
  fail "pi-rules-loader missing"
fi

if [ -f "$PI_AGENT_DIR/extensions/pi-vision-bridge/index.ts" ]; then
  pass "pi-vision-bridge installed"
else
  fail "pi-vision-bridge missing"
fi

check_prompt_placeholders

section "JSON and local configs"
json_valid "$PI_AGENT_DIR/settings.json"
json_valid "$PI_AGENT_DIR/models.json"
json_valid "$PI_AGENT_DIR/mcp.json"
json_valid "$PI_AGENT_DIR/auth.json"
json_valid "$PI_AGENT_DIR/image-gen.json"

placeholder_check "$PI_AGENT_DIR/models.json"
placeholder_check "$PI_AGENT_DIR/auth.json"
placeholder_check "$PI_AGENT_DIR/image-gen.json"

check_provider_model

section "Shared skills"
check_shared_skills

section "MCP readiness"
check_mcp
if [ "$DEEP_MCP" = true ]; then
  section "Deep MCP readiness"
  check_mcp_deep
fi

section "Extension runtime compatibility"
check_until_done_runtime_queue

section "Pi package registry"
if [ "$RUN_PI_LIST" = true ]; then
  if command_exists pi; then
    pi_list_output="$(mktemp "${TMPDIR:-/tmp}/pi67-pi-list.XXXXXX")"
    pi_list_status=0
    run_pi_list_with_timeout "$pi_list_output" "$PI_LIST_TIMEOUT_SECONDS" || pi_list_status=$?
    if [ "$pi_list_status" -eq 0 ]; then
      if grep -Eiq 'warning|error|duplicate|conflict|skipped' "$pi_list_output"; then
        warn "pi list reported package/resource warnings"
      else
        pass "pi list completed without package/resource warnings"
      fi
    elif [ "$pi_list_status" -eq 124 ]; then
      warn "pi list exceeded ${PI_LIST_TIMEOUT_SECONDS}s; skipped package registry check"
    else
      warn "pi list failed; run manually for details"
    fi
    rm -f "$pi_list_output"
  else
    fail "cannot run pi list because pi is missing"
  fi
else
  warn "pi list skipped"
fi

section "Repository hygiene"
json_valid "$REPO_ROOT/settings.json"
json_valid "$REPO_ROOT/models.example.json"
json_valid "$REPO_ROOT/mcp.example.json"
json_valid "$REPO_ROOT/auth.example.json"
json_valid "$REPO_ROOT/image-gen.example.json"
check_repo_secret_scan

if [ "$FAIL_COUNT" -gt 0 ]; then
  RESULT="FAIL"
  EXIT_CODE=1
elif [ "$WARN_COUNT" -gt 0 ]; then
  RESULT="READY WITH WARNINGS"
  EXIT_CODE=0
else
  RESULT="READY"
  EXIT_CODE=0
fi

if [ "$OUTPUT_FORMAT" = "json" ]; then
  emit_json "$RESULT"
else
  echo ""
  echo -e "${CYAN}Summary${NC}"
  echo "  PASS: $PASS_COUNT"
  echo "  WARN: $WARN_COUNT"
  echo "  FAIL: $FAIL_COUNT"

  if [ "$RESULT" = "FAIL" ]; then
    echo -e "${RED}Result: FAIL${NC}"
  elif [ "$RESULT" = "READY WITH WARNINGS" ]; then
    echo -e "${YELLOW}Result: READY WITH WARNINGS${NC}"
    echo "Warnings usually mean API keys, local MCP paths, or optional dependencies still need setup."
  else
    echo -e "${GREEN}Result: READY${NC}"
  fi
fi

exit "$EXIT_CODE"
