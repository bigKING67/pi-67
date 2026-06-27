#!/usr/bin/env bash
set -euo pipefail

# Fast repository smoke test for local development and CI.
# It validates syntax, JSON, prompt placeholders, secret patterns, dry-run install,
# and a temp-agent full install without touching the real ~/.pi/agent.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CI_MODE=false
KEEP_TMP=false
TMP_ROOT=""

usage() {
  cat <<'USAGE'
pi67-smoke validates this repository without touching the real Pi config.

Usage:
  scripts/pi67-smoke.sh [options]

Options:
      --ci        CI-friendly output and checks.
      --keep-tmp  Keep temporary install directory for inspection.
  -h, --help      Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ci)
      CI_MODE=true
      shift
      ;;
    --keep-tmp)
      KEEP_TMP=true
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
  echo -e "  ${GREEN}PASS${NC} $*"
}

warn() {
  echo -e "  ${YELLOW}WARN${NC} $*"
}

fail() {
  echo -e "  ${RED}FAIL${NC} $*" >&2
  exit 1
}

section() {
  echo ""
  echo -e "${CYAN}--- $* ---${NC}"
}

cleanup() {
  rm -f \
    /tmp/pi67-smoke-placeholder.log \
    /tmp/pi67-smoke-release-check.log \
    /tmp/pi67-smoke-secrets.log \
    /tmp/pi67-smoke-install.log \
    /tmp/pi67-smoke-doctor.log \
    /tmp/pi67-smoke-configure-dry.log \
    /tmp/pi67-smoke-configure.log \
    /tmp/pi67-smoke-doctor-configured.log \
    /tmp/pi67-smoke-ops-install.log \
    /tmp/pi67-smoke-restore-dry.log \
    /tmp/pi67-smoke-restore.log \
    /tmp/pi67-smoke-ops-install-2.log \
    /tmp/pi67-smoke-uninstall-dry.log \
    /tmp/pi67-smoke-uninstall.log
  if [ "$KEEP_TMP" = true ]; then
    if [ -n "$TMP_ROOT" ]; then
      warn "kept temp directory: $TMP_ROOT"
    fi
    return
  fi
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

json_valid() {
  local file="$1"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" >/dev/null
}

grep_any() {
  local pattern="$1"
  shift
  if command_exists rg; then
    rg -n "$pattern" "$@"
  else
    grep -R -n -E "$pattern" "$@"
  fi
}

echo ""
echo -e "${CYAN}pi-67 smoke${NC}"
echo "Repository: $REPO_ROOT"
if [ "$CI_MODE" = true ]; then
  echo "Mode      : CI"
fi

section "Required tools"
command_exists bash || fail "bash not found"
pass "bash found"
command_exists node || fail "node is required"
pass "node found: $(node -v 2>/dev/null || echo unknown)"

section "Shell syntax"
bash -n "$REPO_ROOT/install.sh"
bash -n "$REPO_ROOT/scripts/pi67-configure.sh"
bash -n "$REPO_ROOT/scripts/pi67-doctor.sh"
bash -n "$REPO_ROOT/scripts/pi67-release-check.sh"
bash -n "$REPO_ROOT/scripts/pi67-smoke.sh"
if [ -f "$REPO_ROOT/scripts/pi67-restore.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-restore.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-uninstall.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-uninstall.sh"
fi
bash -n "$REPO_ROOT/scripts/xtalpi-tool-smoke.sh"
pass "shell scripts parse"

section "JSON"
for file in settings.json auth.example.json image-gen.example.json models.example.json mcp.example.json package.json; do
  json_valid "$REPO_ROOT/$file"
  pass "valid JSON: $file"
done

section "Release metadata"
"$REPO_ROOT/scripts/pi67-release-check.sh" >/tmp/pi67-smoke-release-check.log
pass "release metadata check completed"

section "Prompt/template hygiene"
if grep_any '\{\{[^}]+\}\}' \
  "$REPO_ROOT/AGENTS.md" \
  "$REPO_ROOT/prompts" \
  "$REPO_ROOT/rules" \
  "$REPO_ROOT/docs" \
  "$REPO_ROOT/scripts" >/tmp/pi67-smoke-placeholder.log 2>/dev/null; then
  cat /tmp/pi67-smoke-placeholder.log >&2
  fail "legacy double-brace placeholders found"
fi
rm -f /tmp/pi67-smoke-placeholder.log
pass "no legacy double-brace placeholders"

section "Secret pattern scan"
if grep_any 'BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+' \
  "$REPO_ROOT/AGENTS.md" \
  "$REPO_ROOT/README.md" \
  "$REPO_ROOT/docs" \
  "$REPO_ROOT/extensions" \
  "$REPO_ROOT/install.sh" \
  "$REPO_ROOT/prompts" \
  "$REPO_ROOT/rules" \
  "$REPO_ROOT/scripts" \
  "$REPO_ROOT/.github" >/tmp/pi67-smoke-secrets.log 2>/dev/null; then
  cat /tmp/pi67-smoke-secrets.log >&2
  fail "possible real secret pattern found"
fi
rm -f /tmp/pi67-smoke-secrets.log
pass "no obvious private key/API token patterns"

section "Temp full install"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-smoke.XXXXXX")"
FAKE_BIN="$TMP_ROOT/bin"
AGENT_DIR="$TMP_ROOT/agent"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/pi" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version)
    echo "0.0.0-smoke"
    ;;
  skill)
    if [ "${2:-}" = "list" ]; then
      echo "smoke skill list"
    else
      echo "smoke pi skill"
    fi
    ;;
  *)
    echo "smoke pi"
    ;;
esac
SH
chmod +x "$FAKE_BIN/pi"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$AGENT_DIR" \
  --backup-dir "$TMP_ROOT/backup" \
  --no-npm \
  --no-doctor \
  --yes >/tmp/pi67-smoke-install.log
pass "temp full install completed"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" >/tmp/pi67-smoke-doctor.log
pass "doctor completed on temp install"

if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' /tmp/pi67-smoke-doctor.log; then
  cat /tmp/pi67-smoke-doctor.log >&2
  fail "doctor did not report a ready result"
fi
pass "doctor readiness result accepted"

section "Configure helper"
mkdir -p "$TMP_ROOT/tmwd-browser-mcp/src"
printf 'console.log("smoke tmwd server")\n' > "$TMP_ROOT/tmwd-browser-mcp/src/server.mjs"
printf 'console.log("smoke js reverse server")\n' > "$TMP_ROOT/tmwd-browser-mcp/src/js-reverse-server.mjs"
cat > "$FAKE_BIN/agent-memory-mcp" <<'SH'
#!/usr/bin/env bash
echo "smoke agent memory"
SH
chmod +x "$FAKE_BIN/agent-memory-mcp"

PATH="$FAKE_BIN:$PATH" \
PI67_XTALPI_API_KEY="smoke_xtalpi_api_key" \
PI67_CODEX_API_KEY="smoke_codex_api_key" \
PI67_DEEPSEEK_API_KEY="smoke_deepseek_api_key" \
PI67_IMAGE_GEN_API_KEY="smoke_image_gen_api_key" \
"$REPO_ROOT/scripts/pi67-configure.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --provider xtalpi-tools \
  --model deepseek-v4-pro \
  --codex-base-url "http://127.0.0.1:8317/v1" \
  --tmwd-repo "$TMP_ROOT/tmwd-browser-mcp" \
  --agent-memory-bin "$FAKE_BIN/agent-memory-mcp" \
  --image-gen-model "gpt-image-2" \
  --no-prompt \
  --no-doctor \
  --dry-run >/tmp/pi67-smoke-configure-dry.log
pass "configure dry-run completed"

PATH="$FAKE_BIN:$PATH" \
PI67_XTALPI_API_KEY="smoke_xtalpi_api_key" \
PI67_CODEX_API_KEY="smoke_codex_api_key" \
PI67_DEEPSEEK_API_KEY="smoke_deepseek_api_key" \
PI67_IMAGE_GEN_API_KEY="smoke_image_gen_api_key" \
"$REPO_ROOT/scripts/pi67-configure.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --provider xtalpi-tools \
  --model deepseek-v4-pro \
  --codex-base-url "http://127.0.0.1:8317/v1" \
  --tmwd-repo "$TMP_ROOT/tmwd-browser-mcp" \
  --agent-memory-bin "$FAKE_BIN/agent-memory-mcp" \
  --image-gen-model "gpt-image-2" \
  --no-prompt \
  --no-doctor >/tmp/pi67-smoke-configure.log
pass "configure applied to temp install"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" >/tmp/pi67-smoke-doctor-configured.log

if grep -q 'Result: READY WITH WARNINGS' /tmp/pi67-smoke-doctor-configured.log; then
  cat /tmp/pi67-smoke-doctor-configured.log >&2
  fail "doctor still reported warnings after configure"
fi
if ! grep -q 'Result: READY' /tmp/pi67-smoke-doctor-configured.log; then
  cat /tmp/pi67-smoke-doctor-configured.log >&2
  fail "doctor did not report READY after configure"
fi
pass "doctor reports READY after configure"

section "Restore/uninstall operations"
OPS_AGENT="$TMP_ROOT/ops-agent"
OPS_BACKUP="$TMP_ROOT/ops-backup"
mkdir -p "$OPS_AGENT/skills"
printf 'old agents\n' > "$OPS_AGENT/AGENTS.md"
printf 'old skill\n' > "$OPS_AGENT/skills/old.txt"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$OPS_BACKUP" \
  --no-npm \
  --no-doctor \
  --yes >/tmp/pi67-smoke-ops-install.log

"$REPO_ROOT/scripts/pi67-restore.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$OPS_BACKUP" \
  --dry-run >/tmp/pi67-smoke-restore-dry.log

"$REPO_ROOT/scripts/pi67-restore.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$OPS_BACKUP" \
  --yes >/tmp/pi67-smoke-restore.log

if [ "$(cat "$OPS_AGENT/AGENTS.md")" != "old agents" ] || [ ! -f "$OPS_AGENT/skills/old.txt" ]; then
  fail "restore did not recover preinstall files"
fi
pass "restore recovered preinstall files"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$TMP_ROOT/ops-backup-2" \
  --no-npm \
  --no-doctor \
  --yes >/tmp/pi67-smoke-ops-install-2.log

"$REPO_ROOT/scripts/pi67-uninstall.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$OPS_AGENT" \
  --dry-run >/tmp/pi67-smoke-uninstall-dry.log

"$REPO_ROOT/scripts/pi67-uninstall.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$OPS_AGENT" \
  --yes >/tmp/pi67-smoke-uninstall.log

if [ -e "$OPS_AGENT/AGENTS.md" ] || [ ! -f "$OPS_AGENT/models.json" ]; then
  fail "uninstall did not remove owned symlinks while preserving local config"
fi
pass "uninstall removed owned symlinks and preserved local config"

section "Summary"
pass "pi-67 smoke passed"
