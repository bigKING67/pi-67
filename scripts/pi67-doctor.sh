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
RUN_SKILL_LIST=true

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
  cat <<'USAGE'
pi67-doctor checks whether the full pi-67 installation is ready.

Usage:
  scripts/pi67-doctor.sh [options]

Options:
      --repo-root DIR      Repository root. Defaults to parent of this script.
      --agent-dir DIR      Pi agent dir. Defaults to ~/.pi/agent.
      --no-skill-list      Skip `pi skill list`.
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
    --no-skill-list)
      RUN_SKILL_LIST=false
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

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "  ${GREEN}PASS${NC} $*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  echo -e "  ${YELLOW}WARN${NC} $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo -e "  ${RED}FAIL${NC} $*"
}

section() {
  echo ""
  echo -e "${CYAN}--- $* ---${NC}"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
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

  if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" >/dev/null 2>&1; then
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
  local source="$REPO_ROOT/$rel"
  local target="$PI_AGENT_DIR/$rel"

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

  if [ -L "$target" ]; then
    pass "installed link: $rel -> $(readlink "$target")"
  else
    warn "installed but not a symlink: $target"
  fi
}

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
  done < <(node "$script" "$REPO_ROOT" "$PI_AGENT_DIR")
}

check_provider_model() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");
const [, , repoRoot, agentDir] = process.argv;

function emit(level, message) {
  console.log(`${level}|${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    emit("FAIL", `cannot read JSON ${file}: ${error.message}`);
    return null;
  }
}

const settings = readJson(path.join(agentDir, "settings.json"));
const models = readJson(path.join(agentDir, "models.json"));
if (!settings || !models) process.exit(0);

const providerId = settings.defaultProvider;
const modelId = settings.defaultModel;

if (!providerId) emit("FAIL", "settings.json missing defaultProvider");
if (!modelId) emit("FAIL", "settings.json missing defaultModel");

const provider = models.providers?.[providerId];
if (!provider) {
  emit("FAIL", `defaultProvider ${providerId} not found in models.json`);
} else {
  emit("PASS", `defaultProvider exists: ${providerId}`);
  const model = Array.isArray(provider.models) ? provider.models.find((item) => item.id === modelId) : null;
  if (model) {
    emit("PASS", `defaultModel exists under ${providerId}: ${modelId}`);
  } else {
    emit("FAIL", `defaultModel ${modelId} not found under provider ${providerId}`);
  }

  if (String(provider.apiKey || "").includes("YOUR_")) {
    emit("WARN", `provider ${providerId} still uses placeholder apiKey`);
  } else if (provider.apiKey) {
    emit("PASS", `provider ${providerId} apiKey is configured`);
  }
}
NODE
  run_node_report "$tmp"
  rm -f "$tmp"
}

check_mcp() {
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<'NODE'
const fs = require("fs");
const path = require("path");
const [, , repoRoot, agentDir] = process.argv;
const home = process.env.HOME || "";

function emit(level, message) {
  console.log(`${level}|${message}`);
}

function expand(value) {
  return String(value || "")
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home);
}

function commandExists(command) {
  if (!command) return false;
  const expanded = expand(command);
  if (expanded.includes("/")) {
    return fs.existsSync(expanded);
  }
  const pathEnv = process.env.PATH || "";
  return pathEnv.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, expanded)));
}

function looksLikePath(value) {
  return typeof value === "string" && (value.includes("/") || value.startsWith("$HOME") || value.startsWith("${HOME}"));
}

const file = path.join(agentDir, "mcp.json");
let config;
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
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
  const commandLabel = expand(server.command);
  if (commandExists(server.command)) {
    emit("PASS", `MCP ${name} command is available: ${commandLabel}`);
  } else {
    emit("WARN", `MCP ${name} command is not available yet: ${commandLabel}`);
  }

  for (const arg of server.args || []) {
    if (!looksLikePath(arg)) continue;
    const expanded = expand(arg);
    if (/^https?:\/\//.test(expanded) || /^wss?:\/\//.test(expanded)) continue;
    if (fs.existsSync(expanded)) {
      emit("PASS", `MCP ${name} path exists: ${expanded}`);
    } else {
      emit("WARN", `MCP ${name} path missing or needs local edit: ${expanded}`);
    }
  }
}
NODE
  run_node_report "$tmp"
  rm -f "$tmp"
}

check_repo_secret_scan() {
  if ! command_exists rg; then
    warn "rg not found; skipped repo secret pattern scan"
    return
  fi

  if rg -n 'BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+' \
    "$REPO_ROOT" \
    --glob '!*.example.json' \
    --glob '!README.md' \
    --glob '!docs/**' \
    --glob '!scripts/pi67-doctor.sh' >/dev/null 2>&1; then
    fail "possible real secret pattern found in tracked repo files"
  else
    pass "repo secret pattern scan found no obvious private keys/API tokens"
  fi
}

echo ""
echo -e "${CYAN}pi-67 doctor${NC}"
echo "Repository : $REPO_ROOT"
echo "Agent dir  : $PI_AGENT_DIR"

section "Core tools"
if command_exists pi; then
  pass "pi found: $(pi --version 2>/dev/null || echo unknown)"
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
check_asset "settings.json"
check_asset "AGENTS.md"
check_asset "extensions"
check_asset "skills"
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

skills_count="$(count_dirs "$PI_AGENT_DIR/skills")"
if [ "$skills_count" -ge 20 ]; then
  pass "skills directories available: $skills_count"
else
  warn "skills directories look low: $skills_count"
fi

if [ -f "$PI_AGENT_DIR/extensions/pi-rules-loader/index.ts" ]; then
  pass "pi-rules-loader installed"
else
  fail "pi-rules-loader missing"
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

section "MCP readiness"
check_mcp

section "Pi runtime"
if [ "$RUN_SKILL_LIST" = true ]; then
  if command_exists pi; then
    if pi skill list >/dev/null 2>&1; then
      pass "pi skill list succeeded"
    else
      warn "pi skill list failed; run manually for details"
    fi
  else
    fail "cannot run pi skill list because pi is missing"
  fi
else
  warn "pi skill list skipped"
fi

section "Repository hygiene"
json_valid "$REPO_ROOT/settings.json"
json_valid "$REPO_ROOT/models.example.json"
json_valid "$REPO_ROOT/mcp.example.json"
json_valid "$REPO_ROOT/auth.example.json"
json_valid "$REPO_ROOT/image-gen.example.json"
check_repo_secret_scan

echo ""
echo -e "${CYAN}Summary${NC}"
echo "  PASS: $PASS_COUNT"
echo "  WARN: $WARN_COUNT"
echo "  FAIL: $FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}Result: FAIL${NC}"
  exit 1
fi

if [ "$WARN_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}Result: READY WITH WARNINGS${NC}"
  echo "Warnings usually mean API keys, local MCP paths, or optional dependencies still need setup."
else
  echo -e "${GREEN}Result: READY${NC}"
fi
