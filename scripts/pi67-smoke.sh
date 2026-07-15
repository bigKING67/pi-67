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
SMOKE_LOG_DIR=""
SMOKE_CREATED_REPO_SETTINGS=false

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
  if [ "$SMOKE_CREATED_REPO_SETTINGS" = true ]; then
    rm -f "$REPO_ROOT/settings.json"
  fi
  if [ "$KEEP_TMP" = true ]; then
    warn "kept temp directory: $TMP_ROOT"
    return
  fi
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-smoke.XXXXXX")"
SMOKE_LOG_DIR="$TMP_ROOT/logs"
mkdir -p "$SMOKE_LOG_DIR"

if [ ! -f "$REPO_ROOT/settings.json" ] && [ -f "$REPO_ROOT/settings.example.json" ]; then
  cp "$REPO_ROOT/settings.example.json" "$REPO_ROOT/settings.json"
  chmod 600 "$REPO_ROOT/settings.json" 2>/dev/null || true
  SMOKE_CREATED_REPO_SETTINGS=true
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

count_backup_dirs() {
  local root="$1"
  if [ ! -d "$root" ]; then
    printf '0\n'
    return
  fi
  find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d '[:space:]'
}

json_valid() {
  local file="$1"
  node "$REPO_ROOT/scripts/pi67-json-utils.cjs" --read "$file" >/dev/null
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
REAL_PI="$(command -v pi 2>/dev/null || true)"

section "Shell syntax"
bash -n "$REPO_ROOT/install.sh"
bash -n "$REPO_ROOT/scripts/pi67-configure.sh"
bash -n "$REPO_ROOT/scripts/pi67-doctor.sh"
bash -n "$REPO_ROOT/scripts/pi67-release.sh"
bash -n "$REPO_ROOT/scripts/pi67-release-check.sh"
bash -n "$REPO_ROOT/scripts/pi67-report.sh"
if [ -f "$REPO_ROOT/scripts/pi67-migrate-skills.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-migrate-skills.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-skill-audit.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-skill-audit.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-sync-external-skills.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-sync-external-skills.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-sync-commerce-skill-pack.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-sync-commerce-skill-pack.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-sync-commerce-skill-pack.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-sync-commerce-skill-pack.mjs"
fi
if [ -f "$REPO_ROOT/scripts/pi67-test-skill-governance.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-test-skill-governance.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-shared-skills-inventory.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-shared-skills-inventory.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-check-external-skills.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-check-external-skills.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh"
fi
bash -n "$REPO_ROOT/scripts/pi67-smoke.sh"
bash -n "$REPO_ROOT/scripts/pi67-status.sh"
bash -n "$REPO_ROOT/scripts/pi67-update.sh"
if [ -f "$REPO_ROOT/scripts/pi67-restore.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-restore.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-uninstall.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-uninstall.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-test-xtalpi-pi-tools.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-test-xtalpi-pi-tools.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-smoke.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-smoke.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-debug-summary.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-debug-summary.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-tool-coverage-audit.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-xtalpi-tool-coverage-audit.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-json-utils.cjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-json-utils.cjs" >/dev/null
fi
node --check "$REPO_ROOT/scripts/pi67-provider-status.mjs" >/dev/null
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-smoke-plan.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-xtalpi-smoke-plan.mjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-provider-capability-probe.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-xtalpi-provider-capability-probe.mjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-fuzz-xtalpi-parser.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-fuzz-xtalpi-parser.mjs" >/dev/null
fi
if [ -f "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs" ]; then
  node --check "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs" >/dev/null
fi
if [ -d "$REPO_ROOT/packages/pi67-cli" ]; then
  while IFS= read -r -d '' file; do
    node --check "$file" >/dev/null
  done < <(find "$REPO_ROOT/packages/pi67-cli" -type f -name '*.mjs' -print0)
  node "$REPO_ROOT/packages/pi67-cli/bin/pi-67.mjs" --dry-run self-update >/dev/null
fi
pass "shell scripts parse"

section "JSON"
for file in settings.example.json auth.example.json image-gen.example.json models.example.json mcp.example.json package.json package-lock.json shared-skill-packs.json shared-skill-packs.lock.json packages/pi67-cli/package.json; do
  json_valid "$REPO_ROOT/$file"
  pass "valid JSON: $file"
done
if [ -f "$REPO_ROOT/extensions/xtalpi-pi-tools/fixtures/replay-cases.json" ]; then
  json_valid "$REPO_ROOT/extensions/xtalpi-pi-tools/fixtures/replay-cases.json"
  pass "valid JSON: extensions/xtalpi-pi-tools/fixtures/replay-cases.json"
fi
if [ -f "$REPO_ROOT/extensions/xtalpi-pi-tools/provider-error-contract.json" ]; then
  json_valid "$REPO_ROOT/extensions/xtalpi-pi-tools/provider-error-contract.json"
  pass "valid JSON: extensions/xtalpi-pi-tools/provider-error-contract.json"
fi
node "$REPO_ROOT/scripts/pi67-json-utils.cjs" --self-test >"${SMOKE_LOG_DIR}/json-utils.log"
pass "JSON compatibility utility self-test completed"
node --check "$REPO_ROOT/scripts/pi67-mcp-config-utils.cjs" >"${SMOKE_LOG_DIR}/mcp-config-utils.log"
pass "MCP config utility syntax check completed"

if git -C "$REPO_ROOT" ls-files --error-unmatch settings.json >/dev/null 2>&1; then
  fail "settings.json must be ignored runtime state, not a tracked repository file"
fi
git -C "$REPO_ROOT" ls-files --error-unmatch settings.example.json >/dev/null 2>&1 \
  || fail "settings.example.json must be tracked"
git -C "$REPO_ROOT" check-ignore -q settings.json \
  || fail "settings.json must be ignored"
if grep -q 'filter=pi67-settings-runtime-state' "$REPO_ROOT/.gitattributes"; then
  fail "legacy settings.json Git clean filter must not remain in .gitattributes"
fi
pass "settings.json is ignored runtime state with a tracked template"

section "Shared skill defaults"
node - "$REPO_ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const repoRoot = process.argv[2];
const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, "settings.example.json"), "utf8"));
const packages = Array.isArray(settings.packages) ? settings.packages : [];
for (const spec of packages) {
  const value = String(spec);
  if (value.includes("github.com/bigKING67/design-craft") || value.includes("github.com/bigKING67/browser67")) {
    throw new Error(`shared skill source should not be an active Pi package: ${spec}`);
  }
}

const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, "mcp.example.json"), "utf8"));
const tmwd = mcp.mcpServers?.tmwd_browser || {};
const jsReverse = mcp.mcpServers?.["js-reverse"] || {};
const tmwdArg = tmwd.args?.[0] || "";
const jsArg = jsReverse.args?.[0] || "";
if (tmwdArg !== "src/mcp/browser/server.mjs") {
  throw new Error(`tmwd_browser example should use cwd-relative browser67 entrypoint: ${tmwdArg}`);
}
if (jsArg !== "src/mcp/js-reverse/server.mjs") {
  throw new Error(`js-reverse example should use cwd-relative browser67 entrypoint: ${jsArg}`);
}
if (tmwd.cwd !== "~/.agents/packages/browser67" || jsReverse.cwd !== "~/.agents/packages/browser67") {
  throw new Error("browser67 MCP examples must use adapter-supported cwd, not $HOME in args");
}
const serialized = JSON.stringify(mcp);
if (serialized.includes("$HOME/") || serialized.includes("${HOME}/") || serialized.includes("%USERPROFILE%")) {
  throw new Error("mcp.example.json must not contain home placeholders in command/args");
}

const { normalizeMcpConfig } = require(path.join(repoRoot, "scripts", "pi67-mcp-config-utils.cjs"));
const browser67Root = path.join(repoRoot, "fixtures", "browser67-root");
const runtime = { mcpServers: {} };
normalizeMcpConfig(runtime, { agentDir: repoRoot, browser67Root });
const normalizedTmwd = runtime.mcpServers.tmwd_browser || {};
const normalizedJsReverse = runtime.mcpServers["js-reverse"] || {};
if (normalizedTmwd.cwd !== browser67Root || normalizedJsReverse.cwd !== browser67Root) {
  throw new Error("browser67Root normalization should write absolute cwd");
}
if (normalizedTmwd.args?.[0] !== "src/mcp/browser/server.mjs") {
  throw new Error(`browser67Root normalization should keep tmwd args cwd-relative: ${normalizedTmwd.args?.[0]}`);
}
if (normalizedJsReverse.args?.[0] !== "src/mcp/js-reverse/server.mjs") {
  throw new Error(`browser67Root normalization should keep js-reverse args cwd-relative: ${normalizedJsReverse.args?.[0]}`);
}
if (String(normalizedTmwd.args?.[0] || "").includes(browser67Root) || String(normalizedJsReverse.args?.[0] || "").includes(browser67Root)) {
  throw new Error("browser67Root normalization must not duplicate absolute paths into args");
}
NODE
pass "shared skill defaults and MCP normalization use adapter-compatible cwd"

section "Release metadata"
if ! "$REPO_ROOT/scripts/pi67-release-check.sh" >"${SMOKE_LOG_DIR}/release-check.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/release-check.log" >&2
  fail "release metadata check failed"
fi
pass "release metadata check completed"

"$REPO_ROOT/scripts/pi67-release.sh" \
  --dry-run \
  --no-smoke \
  --no-github-release >"${SMOKE_LOG_DIR}/release-dry.log"
if ! grep -q 'dry-run completed' "${SMOKE_LOG_DIR}/release-dry.log"; then
  cat "${SMOKE_LOG_DIR}/release-dry.log" >&2
  fail "release automation dry-run did not complete"
fi
pass "release automation dry-run completed"

section "Prompt/template hygiene"
if grep_any '\{\{[^}]+\}\}' \
  "$REPO_ROOT/AGENTS.md" \
  "$REPO_ROOT/prompts" \
  "$REPO_ROOT/rules" \
  "$REPO_ROOT/docs" \
  "$REPO_ROOT/scripts" >"${SMOKE_LOG_DIR}/placeholder.log" 2>/dev/null; then
  cat "${SMOKE_LOG_DIR}/placeholder.log" >&2
  fail "legacy double-brace placeholders found"
fi
rm -f "${SMOKE_LOG_DIR}/placeholder.log"
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
  "$REPO_ROOT/shared-skills" \
  "$REPO_ROOT/.github" >"${SMOKE_LOG_DIR}/secrets.log" 2>/dev/null; then
  cat "${SMOKE_LOG_DIR}/secrets.log" >&2
  fail "possible real secret pattern found"
fi
rm -f "${SMOKE_LOG_DIR}/secrets.log"
pass "no obvious private key/API token patterns"

section "Portability scan"
PERSONAL_HOME_PREFIX_PART_A="/Use"
PERSONAL_HOME_PREFIX_PART_B="rs/"
PERSONAL_USER_PART_A="gao"
PERSONAL_USER_PART_B="qian"
PERSONAL_WORKSPACE_PART_A="six"
PERSONAL_WORKSPACE_PART_B="seven"
PORTABILITY_PATTERN="${PERSONAL_HOME_PREFIX_PART_A}${PERSONAL_HOME_PREFIX_PART_B}${PERSONAL_USER_PART_A}${PERSONAL_USER_PART_B}|Documents/${PERSONAL_WORKSPACE_PART_A}${PERSONAL_WORKSPACE_PART_B}|${PERSONAL_USER_PART_A}${PERSONAL_USER_PART_B}"
if git -C "$REPO_ROOT" grep -n -E "$PORTABILITY_PATTERN" -- . >"${SMOKE_LOG_DIR}/portability.log" 2>/dev/null; then
  cat "${SMOKE_LOG_DIR}/portability.log" >&2
  fail "personal machine paths found in repository content"
fi
rm -f "${SMOKE_LOG_DIR}/portability.log"
pass "no personal machine paths"

section "Temp full install"
FAKE_BIN="$TMP_ROOT/bin"
AGENT_DIR="$TMP_ROOT/agent"

section "Zero-credential Pi startup"
if [ -n "$REAL_PI" ] && command_exists expect; then
  ZERO_KEY_AGENT="$TMP_ROOT/zero-key-agent"
  ZERO_KEY_LOG="$TMP_ROOT/zero-key-pi.log"
  mkdir -p "$ZERO_KEY_AGENT/extensions"
  cp -R "$REPO_ROOT/extensions/xtalpi-pi-tools" "$ZERO_KEY_AGENT/extensions/xtalpi-pi-tools"
  cp "$REPO_ROOT/models.example.json" "$ZERO_KEY_AGENT/models.json"
  node - "$REPO_ROOT/settings.example.json" "$ZERO_KEY_AGENT/settings.json" "$ZERO_KEY_AGENT/auth.json" <<'NODE'
const fs = require("fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
settings.defaultProvider = "xtalpi-pi-tools";
settings.defaultModel = "deepseek-v4-pro";
settings.packages = [];
fs.writeFileSync(process.argv[3], `${JSON.stringify(settings, null, 2)}\n`);
fs.writeFileSync(process.argv[4], "{}\n");
NODE
  if PI67_REAL_PI="$REAL_PI" PI67_ZERO_KEY_AGENT="$ZERO_KEY_AGENT" PI67_ZERO_KEY_LOG="$ZERO_KEY_LOG" expect <<'EXPECT'
log_user 0
log_file -noappend $env(PI67_ZERO_KEY_LOG)
set timeout 30
spawn env PI_CODING_AGENT_DIR=$env(PI67_ZERO_KEY_AGENT) PI_AGENT_DIR=$env(PI67_ZERO_KEY_AGENT) PI_OFFLINE=1 PI_STARTUP_BENCHMARK=1 XTALPI_PI_TOOLS_API_KEY= XTALPI_API_KEY= PI67_XTALPI_PI_TOOLS_API_KEY= PI67_XTALPI_API_KEY= $env(PI67_REAL_PI) --offline
expect eof
set result [wait]
exit [lindex $result 3]
EXPECT
  then
    if grep -Fq '"apiKey" or "oauth" is required when defining models' "$ZERO_KEY_LOG"; then
      fail "zero-credential Pi startup still hit the provider registration gate"
    fi
    pass "real Pi entered and exited interactive startup with no provider key"
  else
    tail -n 80 "$ZERO_KEY_LOG" >&2 || true
    fail "real Pi zero-credential startup failed"
  fi
else
  warn "real Pi PTY startup skipped (requires installed pi and expect); extension registration unit coverage still runs"
fi

FIRST_SHARED_SKILL_DIR="$(find "$REPO_ROOT/shared-skills" -mindepth 1 -maxdepth 1 -type d -print | sort | head -n 1)"
FIRST_SHARED_SKILL_NAME="$(basename "$FIRST_SHARED_SKILL_DIR")"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/pi" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version)
    echo "0.80.6-smoke"
    ;;
  list)
    if [ "${PI67_SMOKE_PI_LIST_WARNING:-}" = "1" ]; then
      echo "warning: duplicate package resource skipped" >&2
    else
      echo "smoke package list"
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
  --skills-dir "$TMP_ROOT/shared-skills" \
  --backup-dir "$TMP_ROOT/backup" \
  --no-npm \
  --no-doctor \
  --yes >"${SMOKE_LOG_DIR}/install.log"
pass "temp full install completed"

if [ ! -f "$AGENT_DIR/pi67-report.json" ]; then
  cat "${SMOKE_LOG_DIR}/install.log" >&2
  fail "install did not write pi67-report.json"
fi
node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expectedSkillsRoot = process.argv[2];
if (report.schemaVersion !== 2) throw new Error(`unexpected report schemaVersion: ${report.schemaVersion}`);
if (report.schemaId !== "pi67-report/v2") throw new Error(`unexpected report schemaId: ${report.schemaId}`);
if (report.operation !== "install") throw new Error(`unexpected report operation: ${report.operation}`);
if (report.pi67?.version !== report.pi67Version) throw new Error("pi67.version does not match legacy pi67Version");
if (!report.reportPolicy?.currentFileOverwritten) throw new Error("report overwrite policy missing");
if (!report.sharedSkills || report.sharedSkills.sourceCount < 1) throw new Error("report sharedSkills missing");
if (report.sharedSkillsRoot !== expectedSkillsRoot) throw new Error(`report sharedSkillsRoot mismatch: ${report.sharedSkillsRoot}`);
if (report.sharedSkills.canonicalRoot !== expectedSkillsRoot) throw new Error(`report sharedSkills canonicalRoot mismatch: ${report.sharedSkills.canonicalRoot}`);
if (report.sharedSkills.missingInstalled.length !== 0) throw new Error(`shared skills missing from temp root: ${report.sharedSkills.missingInstalled.join(", ")}`);
if (report.sharedSkillPacks?.schemaId !== "pi67-shared-skill-packs-status/v1") throw new Error("report sharedSkillPacks schema missing");
if (!report.sharedSkillPacks.registry?.valid) throw new Error(`report shared Skill Pack registry invalid: ${(report.sharedSkillPacks.errors || []).join("; ")}`);
if (report.sharedSkillPacks.summary?.attention !== 0) throw new Error("fresh install shared Skill Pack is inconsistent");
if (!Array.isArray(report.externalPackages) || report.externalPackages.length !== 0) throw new Error("report externalPackages should be empty under shared skill governance");
if (report.doctor?.skipped !== true) throw new Error("install --no-doctor report should mark doctor skipped");
' "$AGENT_DIR/pi67-report.json" "$TMP_ROOT/shared-skills"
pass "install report JSON written"

INSTALL_CONFLICT_AGENT="$TMP_ROOT/install-conflict-agent"
INSTALL_CONFLICT_SKILLS="$TMP_ROOT/install-conflict-shared-skills"
mkdir -p "$INSTALL_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME"
printf '# Existing newer global skill\n' > "$INSTALL_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME/SKILL.md"
PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$INSTALL_CONFLICT_AGENT" \
  --skills-dir "$INSTALL_CONFLICT_SKILLS" \
  --backup-dir "$TMP_ROOT/install-conflict-backup" \
  --no-npm \
  --no-doctor \
  --no-report \
  --yes >"${SMOKE_LOG_DIR}/install-conflict.log" 2>&1
if ! grep -q "preserved 1 user-modified global Skills: $FIRST_SHARED_SKILL_NAME" "${SMOKE_LOG_DIR}/install-conflict.log"; then
  cat "${SMOKE_LOG_DIR}/install-conflict.log" >&2
  fail "install did not keep existing different shared skill"
fi
if grep -q 'dirHash=' "${SMOKE_LOG_DIR}/install-conflict.log"; then
  cat "${SMOKE_LOG_DIR}/install-conflict.log" >&2
  fail "default install drift output exposed verbose per-Skill hashes"
fi
if ! grep -q "Existing newer global skill" "$INSTALL_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME/SKILL.md"; then
  cat "$INSTALL_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME/SKILL.md" >&2
  fail "install overwrote existing different shared skill"
fi
pass "install keeps existing different shared skills by default"

if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$TMP_ROOT/install-strict-agent" \
  --skills-dir "$INSTALL_CONFLICT_SKILLS" \
  --backup-dir "$TMP_ROOT/install-strict-backup" \
  --no-npm \
  --no-doctor \
  --no-report \
  --strict-shared-skills \
  --yes >"${SMOKE_LOG_DIR}/install-strict-conflict.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/install-strict-conflict.log" >&2
  fail "install strict shared skill mode accepted a conflict"
fi
pass "install strict shared skill mode blocks conflicts"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$INSTALL_CONFLICT_AGENT" \
  --skills-dir "$INSTALL_CONFLICT_SKILLS" \
  --json >"${SMOKE_LOG_DIR}/doctor-shared-conflict-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const check = data.checks.find((item) => item.message.includes("preserved user-modified global skills differ from pi-67 source"));
if (!check) throw new Error("doctor did not report shared skill mismatch");
if (check.level !== "WARN") throw new Error(`doctor mismatch should warn by default, got ${check.level}`);
' "${SMOKE_LOG_DIR}/doctor-shared-conflict-json.log"
pass "doctor warns on different existing shared skills by default"

if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$INSTALL_CONFLICT_AGENT" \
  --skills-dir "$INSTALL_CONFLICT_SKILLS" \
  --strict-shared-skills \
  --json >"${SMOKE_LOG_DIR}/doctor-shared-strict-json.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/doctor-shared-strict-json.log" >&2
  fail "doctor strict shared skill mode accepted a conflict"
fi
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const check = data.checks.find((item) => item.message.includes("preserved user-modified global skills differ from pi-67 source"));
if (!check) throw new Error("doctor strict did not report shared skill mismatch");
if (check.level !== "FAIL") throw new Error(`doctor strict mismatch should fail, got ${check.level}`);
' "${SMOKE_LOG_DIR}/doctor-shared-strict-json.log"
pass "doctor strict shared skill mode blocks conflicts"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --agent-dir "$AGENT_DIR" >"${SMOKE_LOG_DIR}/doctor.log"
pass "doctor completed on temp install"

if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' "${SMOKE_LOG_DIR}/doctor.log"; then
  cat "${SMOKE_LOG_DIR}/doctor.log" >&2
  fail "doctor did not report a ready result"
fi
pass "doctor readiness result accepted"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --quiet >"${SMOKE_LOG_DIR}/doctor-quiet.log"
if grep -q -- '--- Core tools ---' "${SMOKE_LOG_DIR}/doctor-quiet.log"; then
  cat "${SMOKE_LOG_DIR}/doctor-quiet.log" >&2
  fail "doctor --quiet printed detailed sections"
fi
if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' "${SMOKE_LOG_DIR}/doctor-quiet.log"; then
  cat "${SMOKE_LOG_DIR}/doctor-quiet.log" >&2
  fail "doctor --quiet did not report a ready result"
fi
pass "doctor quiet output completed"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --json >"${SMOKE_LOG_DIR}/doctor-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaVersion !== 2) throw new Error(`unexpected doctor schemaVersion: ${data.schemaVersion}`);
if (data.schemaId !== "pi67-doctor/v2") throw new Error(`unexpected doctor schemaId: ${data.schemaId}`);
if (data.generatedBy !== "scripts/pi67-doctor.sh") throw new Error("doctor generatedBy missing");
if (data.diagnostics?.deepMcp !== false) throw new Error("doctor diagnostics.deepMcp should be false");
if (!["READY", "READY WITH WARNINGS"].includes(data.result)) {
  throw new Error(`unexpected result: ${data.result}`);
}
if (!data.counts || data.counts.fail !== 0) {
  throw new Error("doctor JSON reported failures");
}
if (!Array.isArray(data.checks) || data.checks.length === 0) {
  throw new Error("doctor JSON missing checks");
}
' "${SMOKE_LOG_DIR}/doctor-json.log"
pass "doctor JSON output parsed"

section "Shared Skill Pack diagnostics"
PACK_SKILL_NAME="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.packs[0].skills[0]);' "$REPO_ROOT/shared-skill-packs.json")"
printf '# smoke conflict\n' > "$TMP_ROOT/shared-skills/$PACK_SKILL_NAME/SKILL.md"
node "$REPO_ROOT/scripts/pi67-shared-skill-packs-status.mjs" \
  --repo-root "$REPO_ROOT" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --json > "${SMOKE_LOG_DIR}/skill-pack-status-conflict.json"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaId !== "pi67-shared-skill-packs-status/v1") throw new Error(`unexpected schemaId: ${data.schemaId}`);
if (!data.registry?.valid) throw new Error(`registry should remain valid: ${(data.errors || []).join("; ")}`);
if (!data.lock?.valid) throw new Error(`provenance lock should remain valid: ${(data.errors || []).join("; ")}`);
if (data.summary?.attention !== 1) throw new Error(`expected one inconsistent pack: ${JSON.stringify(data.summary)}`);
if (!data.packs?.[0]?.conflictSkills?.includes(process.argv[2])) throw new Error("pack conflict skill name missing");
if (!data.packs?.[0]?.commands?.preview?.endsWith("--dry-run")) throw new Error("pack preview command must be non-writing");
' "${SMOKE_LOG_DIR}/skill-pack-status-conflict.json" "$PACK_SKILL_NAME"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-pi-list \
  --json > "${SMOKE_LOG_DIR}/doctor-skill-pack-conflict.json"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const check = data.checks.find((item) => item.message.includes("shared Skill Pack differs"));
if (!check || check.level !== "WARN") throw new Error(`pack conflict should warn by default: ${JSON.stringify(check)}`);
' "${SMOKE_LOG_DIR}/doctor-skill-pack-conflict.json"

if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-pi-list \
  --strict-shared-skills \
  --json > "${SMOKE_LOG_DIR}/doctor-skill-pack-conflict-strict.json" 2>&1; then
  fail "doctor strict shared skill mode accepted a Skill Pack conflict"
fi
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const check = data.checks.find((item) => item.message.includes("shared Skill Pack differs"));
if (!check || check.level !== "FAIL") throw new Error(`strict pack conflict should fail: ${JSON.stringify(check)}`);
' "${SMOKE_LOG_DIR}/doctor-skill-pack-conflict-strict.json"
bash "$REPO_ROOT/scripts/pi67-status.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-remote \
  --no-xtalpi-smoke \
  --json > "${SMOKE_LOG_DIR}/status-skill-pack-conflict.json"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.sharedSkillPacks?.summary?.attention !== 1) throw new Error("status did not expose the inconsistent Pack");
if (!data.recommendations?.some((item) => item.includes("skills sync-pack") && item.includes("--dry-run"))) {
  throw new Error("status did not recommend the non-writing Pack preview");
}
if (data.recommendations?.some((item) => item.includes("--yes"))) {
  throw new Error("status must not recommend the writing Pack sync form");
}
' "${SMOKE_LOG_DIR}/status-skill-pack-conflict.json"
cp "$REPO_ROOT/shared-skills/$PACK_SKILL_NAME/SKILL.md" "$TMP_ROOT/shared-skills/$PACK_SKILL_NAME/SKILL.md"
pass "shared Skill Pack helper, doctor strictness, and safe status recommendations passed"

section "Xtalpi smoke status core"
XTALPI_SMOKE_FIXTURE_DIR="$TMP_ROOT/xtalpi-smoke-status-fixture"
XTALPI_SMOKE_DEBUG_SUMMARY="$TMP_ROOT/xtalpi-debug-summary-fixture.sh"
mkdir -p "$XTALPI_SMOKE_FIXTURE_DIR"
cat > "$XTALPI_SMOKE_DEBUG_SUMMARY" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --history)
    cat <<'JSON'
{
  "schema": "xtalpi-pi-tools.smoke-history.v1",
  "requested": 3,
  "found": 1,
  "totalArtifacts": 1,
  "candidateArtifacts": 1,
  "filteredOutArtifacts": 0,
  "runs": [
    {
      "runId": "fixture-001",
      "runKind": "full-suite",
      "ok": true,
      "failures": 0,
      "cases": 8,
      "requestCount": 3,
      "requestLatencyMsMin": 111,
      "requestLatencyMsMax": 2222,
      "requestLatencyMsAvg": 777,
      "slowRequestCount": 1,
      "slowRequestThresholdMs": 600,
      "toolSelectionReasonCodes": {
        "core_tool": 6,
        "prompt_path_file": 2
      },
      "selectedToolSelectionReasonCodes": {
        "core_tool": 4,
        "prompt_path_file": 2
      },
      "omittedToolSelectionReasonCodes": {
        "core_tool": 2
      },
      "runtimeFingerprint": {
        "selectedToolNames": ["read", "bash"],
        "maxTools": [24],
        "toolSelectionClipped": [false],
        "toolSelectionOmittedCount": [0],
        "toolSelectionValidCount": [2],
        "toolSelectionPromptSources": ["latest_user"]
      }
    }
  ]
}
JSON
    ;;
  --trend-gate)
    cat <<'JSON'
{
  "schema": "xtalpi-pi-tools.smoke-trend-gate.v1",
  "requested": 3,
  "found": 1,
  "ok": true,
  "gateFailures": [],
  "history": {
    "candidateArtifacts": 1,
    "filteredOutArtifacts": 0,
    "filter": {
      "runKinds": ["full-suite"]
    },
    "runs": [
      {
        "runId": "fixture-001",
        "runKind": "full-suite",
        "ok": true,
        "requestCount": 3,
        "requestLatencyMsMin": 111,
        "requestLatencyMsMax": 2222,
        "requestLatencyMsAvg": 777,
        "slowRequestCount": 1,
        "slowRequestThresholdMs": 600,
        "toolSelectionReasonCodes": {
          "core_tool": 6,
          "prompt_path_file": 2
        },
        "selectedToolSelectionReasonCodes": {
          "core_tool": 4,
          "prompt_path_file": 2
        },
        "omittedToolSelectionReasonCodes": {
          "core_tool": 2
        },
        "runtimeFingerprint": {
          "selectedToolNames": ["read", "bash"],
          "maxTools": [24],
          "toolSelectionClipped": [false],
          "toolSelectionOmittedCount": [0],
          "toolSelectionValidCount": [2],
          "toolSelectionPromptSources": ["latest_user"]
        }
      }
    ]
  }
}
JSON
    ;;
  --drift)
    cat <<'JSON'
{
  "schema": "xtalpi-pi-tools.smoke-drift.v1",
  "requested": 10,
  "found": 1,
  "candidateArtifacts": 1,
  "filteredOutArtifacts": 0,
  "filter": {
    "runKinds": ["full-suite"]
  },
  "drift": {
    "providerModelChanged": false,
    "caseSetChanged": false,
    "runtimeFingerprintChanged": false,
    "runtimeBoundsChanged": false,
    "providerHealthChanged": false,
    "qualitySignalsPresent": true
  },
  "qualityTotals": {
    "requestLatencyMsMax": 2222,
    "slowRequestCount": 1
  },
  "runs": [
    {
      "runId": "fixture-001",
      "runKind": "full-suite",
      "requestCount": 3,
      "requestLatencyMsMin": 111,
      "requestLatencyMsMax": 2222,
      "requestLatencyMsAvg": 777,
      "slowRequestCount": 1,
      "slowRequestThresholdMs": 600
    }
  ]
}
JSON
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$XTALPI_SMOKE_DEBUG_SUMMARY"
node - "$REPO_ROOT" "$XTALPI_SMOKE_FIXTURE_DIR" "$XTALPI_SMOKE_DEBUG_SUMMARY" <<'NODE'
const path = require("path");
const [repoRoot, artifactDir, debugSummaryScript] = process.argv.slice(2);
const { collectXtalpiSmokeStatus } = require(path.join(repoRoot, "scripts", "pi67-xtalpi-smoke-status-core.cjs"));
const status = collectXtalpiSmokeStatus({
  repoRoot,
  artifactDir,
  debugSummaryScript,
  historyLimit: 3,
  strictTrendLimit: 3,
  driftLimit: 10,
  timeoutMs: 5000,
});
const latest = status.history?.data?.runs?.[0];
const trendLatest = status.strictTrendGate?.data?.runs?.[0];
const driftLatest = status.drift?.data?.runs?.[0];
const driftTotals = status.drift?.data?.qualityTotals;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(status.result === "OK", `unexpected status result: ${status.result}`);
assert(latest?.requestLatencyMsMin === 111, "history requestLatencyMsMin was not preserved");
assert(latest?.requestLatencyMsMax === 2222, "history requestLatencyMsMax was not preserved");
assert(latest?.requestLatencyMsAvg === 777, "history requestLatencyMsAvg was not preserved");
assert(latest?.requestCount === 3, "history requestCount was not preserved");
assert(latest?.slowRequestCount === 1, "history slowRequestCount was not preserved");
assert(latest?.slowRequestThresholdMs === 600, "history slowRequestThresholdMs was not preserved");
assert(trendLatest?.requestLatencyMsMax === 2222, "trend request latency was not preserved");
assert(trendLatest?.toolSelectionReasonCodes?.core_tool === 6, "trend reason codes were not preserved");
assert(trendLatest?.selectedToolSelectionReasonCodes?.prompt_path_file === 2, "selected-tool reason codes were not preserved");
assert(trendLatest?.omittedToolSelectionReasonCodes?.core_tool === 2, "omitted-tool reason codes were not preserved");
assert(trendLatest?.runtimeSelectedToolNames?.includes("read"), "runtime selected tool names were not preserved");
assert(status.reasonCodeTelemetry?.supported === true, "reason-code telemetry should be supported for the fixture");
assert(status.rankingTrendGate?.ok === true, "ranking trend gate should run for reason-code-aware artifacts");
assert(status.rankingTrendGate?.skipped !== true, "ranking trend gate should not be skipped for reason-code-aware artifacts");
assert(driftLatest?.slowRequestCount === 1, "drift run slow request count was not preserved");
assert(driftTotals?.requestLatencyMsMax === 2222, "drift quality total request latency was not preserved");
assert(driftTotals?.slowRequestCount === 1, "drift quality total slow request count was not preserved");
NODE
pass "xtalpi smoke status core preserves latency telemetry"

section "Status summary"
PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-status.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-remote >"${SMOKE_LOG_DIR}/status.log"
if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' "${SMOKE_LOG_DIR}/status.log"; then
  cat "${SMOKE_LOG_DIR}/status.log" >&2
  fail "status text output did not complete"
fi
pass "status text output completed"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-status.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-remote \
  --json >"${SMOKE_LOG_DIR}/status-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaVersion !== 1) throw new Error(`unexpected status schemaVersion: ${data.schemaVersion}`);
if (data.schemaId !== "pi67-status/v1") throw new Error(`unexpected status schemaId: ${data.schemaId}`);
if (data.report?.schemaId !== "pi67-report/v2") throw new Error("status did not read report schema v2");
if (data.report?.stale !== false) throw new Error(`status reported stale report: ${(data.report?.staleReasons || []).join("; ")}`);
if (data.sharedSkillPacks?.schemaId !== "pi67-shared-skill-packs-status/v1") throw new Error("status sharedSkillPacks schema missing");
if (data.sharedSkillPacks.summary?.attention !== 0) throw new Error("status shared Skill Pack should be consistent");
if (!Array.isArray(data.recommendations) || data.recommendations.length === 0) {
  throw new Error("status recommendations missing");
}
' "${SMOKE_LOG_DIR}/status-json.log"
pass "status JSON output parsed"

section "Skill audit helper"
mkdir -p "$TMP_ROOT/skill-audit-agent/skills" "$TMP_ROOT/external-skills"
printf 'full-output-enforcement\nlegacy-missing\n' > "$TMP_ROOT/legacy-skills.txt"
printf 'legacy-missing -> ../../../.agents/skills/legacy-missing\n' > "$TMP_ROOT/legacy-links.txt"

bash "$REPO_ROOT/scripts/pi67-skill-audit.sh" \
  --agent-dir "$TMP_ROOT/skill-audit-agent" \
  --legacy-names "$TMP_ROOT/legacy-skills.txt" \
  --legacy-links "$TMP_ROOT/legacy-links.txt" \
  --skill-root "$TMP_ROOT/external-skills" >"${SMOKE_LOG_DIR}/skill-audit.log"
pass "skill audit text output completed"

bash "$REPO_ROOT/scripts/pi67-skill-audit.sh" \
  --agent-dir "$TMP_ROOT/skill-audit-agent" \
  --legacy-names "$TMP_ROOT/legacy-skills.txt" \
  --legacy-links "$TMP_ROOT/legacy-links.txt" \
  --skill-root "$TMP_ROOT/external-skills" \
  --json >"${SMOKE_LOG_DIR}/skill-audit-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaId !== "pi67-skill-audit/v1") throw new Error(`unexpected schemaId: ${data.schemaId}`);
if (!data.repository || data.repository.skillCount < 1) throw new Error("missing repository skills");
const missing = data.legacy?.legacyOnly?.find((entry) => entry.name === "legacy-missing");
if (!missing) throw new Error("missing legacy-only skill audit entry");
if (missing.classification !== "stale_broken_link") throw new Error(`unexpected classification: ${missing.classification}`);
' "${SMOKE_LOG_DIR}/skill-audit-json.log"
pass "skill audit JSON output parsed"

section "xtalpi-pi-tools extension coverage audit"
bash "$REPO_ROOT/scripts/pi67-xtalpi-tool-coverage-audit.sh" \
  --agent-dir "$REPO_ROOT" \
  --include pi-rules-loader \
  --include pi-vision-bridge >"${SMOKE_LOG_DIR}/xtalpi-tool-coverage.log"
pass "xtalpi-pi-tools extension coverage text output completed"

bash "$REPO_ROOT/scripts/pi67-xtalpi-tool-coverage-audit.sh" \
  --agent-dir "$REPO_ROOT" \
  --include pi-rules-loader \
  --include pi-vision-bridge \
  --json >"${SMOKE_LOG_DIR}/xtalpi-tool-coverage-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaId !== "pi67-xtalpi-tool-coverage-audit/v1") throw new Error(`unexpected schemaId: ${data.schemaId}`);
if (!data.summary || data.summary.total < 1 || data.summary.installed < 1) throw new Error("coverage audit summary is empty");
const installedMissingEvidence = data.entries.filter(
  (entry) => entry.installed && Object.values(entry.missingExpected || {}).some((items) => items.length > 0),
);
if (installedMissingEvidence.length) {
  throw new Error(`coverage audit has missing expected evidence for installed packages: ${installedMissingEvidence.map((entry) => entry.spec).join(", ")}`);
}
for (const spec of ["npm:@ff-labs/pi-fff", "npm:pi-smart-fetch", "npm:pi-mcp-adapter"]) {
  const entry = data.entries.find((candidate) => candidate.spec === spec);
  if (!entry) throw new Error(`coverage audit missing package entry: ${spec}`);
  if (entry.installed !== true && entry.surface !== "missing") {
    throw new Error(`coverage audit emitted invalid missing package entry: ${spec}`);
  }
}
const rulesLoader = data.entries.find((candidate) => candidate.spec === "local:extensions/pi-rules-loader");
if (!rulesLoader || rulesLoader.installed !== true) throw new Error("coverage audit did not include pi-rules-loader");
if (rulesLoader.surface !== "command_or_hook_only") throw new Error(`unexpected pi-rules-loader surface: ${rulesLoader.surface}`);
const visionBridge = data.entries.find((candidate) => candidate.spec === "local:extensions/pi-vision-bridge");
if (!visionBridge || visionBridge.installed !== true) throw new Error("coverage audit did not include pi-vision-bridge");
if (!visionBridge.modelCallableTools.includes("vision_read")) throw new Error("coverage audit did not find vision_read");
' "${SMOKE_LOG_DIR}/xtalpi-tool-coverage-json.log"
pass "xtalpi-pi-tools extension coverage JSON output parsed"

section "xtalpi-pi-tools smoke plan"
node "$REPO_ROOT/scripts/pi67-xtalpi-smoke-plan.mjs" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$REPO_ROOT" >"${SMOKE_LOG_DIR}/xtalpi-smoke-plan.log"
pass "xtalpi-pi-tools smoke plan text output completed"

node "$REPO_ROOT/scripts/pi67-xtalpi-smoke-plan.mjs" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$REPO_ROOT" \
  --json >"${SMOKE_LOG_DIR}/xtalpi-smoke-plan-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaId !== "pi67-xtalpi-smoke-plan/v1") throw new Error(`unexpected schemaId: ${data.schemaId}`);
if (!data.summary || data.summary.packages < 1 || data.summary.installed < 1) throw new Error("smoke plan summary is empty");
if (data.summary.unknownPolicyPackages !== 0) throw new Error("smoke plan has unknown policy packages");
if (!data.recommendedCommands || !data.recommendedCommands.windowsExpanded.includes("extension-expanded")) throw new Error("missing Windows expanded smoke command");
const smartFetch = data.packages.find((entry) => entry.spec === "npm:pi-smart-fetch");
if (!smartFetch) throw new Error("smoke plan missing smart-fetch entry");
if (smartFetch.installed) {
  if (!smartFetch.windowsCoveredTools.includes("batch_web_fetch")) throw new Error("smoke plan did not cover batch_web_fetch");
} else if (smartFetch.status !== "missing_package") {
  throw new Error(`unexpected smart-fetch status: ${smartFetch.status}`);
}
const rulesLoader = data.packages.find((entry) => entry.spec === "local:extensions/pi-rules-loader");
if (!rulesLoader || rulesLoader.status !== "not_model_callable") throw new Error("smoke plan did not classify rules-loader");
const visionBridge = data.packages.find((entry) => entry.spec === "local:extensions/pi-vision-bridge");
if (!visionBridge || visionBridge.smokePolicy !== "manual_artifact") throw new Error("smoke plan did not classify vision bridge");
' "${SMOKE_LOG_DIR}/xtalpi-smoke-plan-json.log"
pass "xtalpi-pi-tools smoke plan JSON output parsed"

section "Skill governance helper tests"
"$REPO_ROOT/scripts/pi67-test-skill-governance.sh" \
  --repo-root "$REPO_ROOT" >"${SMOKE_LOG_DIR}/skill-governance.log"
pass "skill governance helper tests completed"

section "Release artifact smoke"
"$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh" \
  --repo-root "$REPO_ROOT" \
  --ref WORKTREE >"${SMOKE_LOG_DIR}/release-artifact.log"
pass "release artifact smoke completed"

section "xtalpi-pi-tools unit tests"
"$REPO_ROOT/scripts/pi67-test-xtalpi-pi-tools.sh" >"${SMOKE_LOG_DIR}/xtalpi-pi-tools-test.log"
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs" ]; then
  node "$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs" --self-test >"${SMOKE_LOG_DIR}/xtalpi-provider-health-test.log"
fi
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-provider-capability-probe.mjs" ]; then
  node "$REPO_ROOT/scripts/pi67-xtalpi-provider-capability-probe.mjs" --self-test >"${SMOKE_LOG_DIR}/xtalpi-provider-capability-probe-test.log"
fi
if [ -f "$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs" ]; then
  node "$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs" --self-test >"${SMOKE_LOG_DIR}/xtalpi-provider-error-contract.log"
  node "$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs" >>"${SMOKE_LOG_DIR}/xtalpi-provider-error-contract.log"
fi
if [ -f "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs" ]; then
  node "$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs" --self-test >"${SMOKE_LOG_DIR}/until-done-runtime-queue.log"
fi
pass "xtalpi-pi-tools protocol tests completed"

section "Temp in-place install"
INPLACE_AGENT="$TMP_ROOT/in-place-agent"
mkdir -p "$INPLACE_AGENT"

while IFS= read -r -d '' file; do
  if [ ! -e "$REPO_ROOT/$file" ]; then
    continue
  fi
  mkdir -p "$INPLACE_AGENT/$(dirname "$file")"
  cp -p "$REPO_ROOT/$file" "$INPLACE_AGENT/$file"
done < <(git -C "$REPO_ROOT" ls-files -z --cached --others --exclude-standard)

git -C "$INPLACE_AGENT" init -q
git -C "$INPLACE_AGENT" config user.email "pi67-smoke@example.invalid"
git -C "$INPLACE_AGENT" config user.name "pi67 smoke"
git -C "$INPLACE_AGENT" add .
git -C "$INPLACE_AGENT" commit -q -m "pi67 smoke in-place baseline"

PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/install.sh" \
  --agent-dir "$INPLACE_AGENT" \
  --skills-dir "$TMP_ROOT/inplace-shared-skills" \
  --no-npm \
  --no-doctor \
  --yes >"${SMOKE_LOG_DIR}/inplace-install.log"
pass "temp in-place install completed"

if [ -L "$INPLACE_AGENT/AGENTS.md" ]; then
  cat "${SMOKE_LOG_DIR}/inplace-install.log" >&2
  fail "in-place install turned AGENTS.md into a symlink"
fi
for path in AGENTS.md rules scripts shared-skills docs prompts extensions templates; do
  if [ ! -e "$INPLACE_AGENT/$path" ]; then
    fail "in-place install removed tracked asset: $path"
  fi
done
if [ -e "$INPLACE_AGENT/skills" ] || [ -L "$INPLACE_AGENT/skills" ]; then
  fail "in-place install left legacy active skills directory"
fi
if [ ! -d "$TMP_ROOT/inplace-shared-skills" ]; then
  fail "in-place install did not install shared skills"
fi
if find "$INPLACE_AGENT" -maxdepth 1 -name 'backup-*' -print -quit | grep -q .; then
  fail "in-place install created an asset backup directory"
fi
pass "in-place tracked assets preserved"

for path in settings.json models.json mcp.json auth.json image-gen.json pi67-report.json; do
  if [ ! -e "$INPLACE_AGENT/$path" ]; then
    fail "in-place install did not create local file: $path"
  fi
  git -C "$INPLACE_AGENT" check-ignore -q "$path" || fail "in-place local file is not ignored: $path"
done
pass "in-place local files created and ignored"

if ! PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/scripts/pi67-doctor.sh" \
  --repo-root "$INPLACE_AGENT" \
  --agent-dir "$INPLACE_AGENT" \
  --skills-dir "$TMP_ROOT/inplace-shared-skills" \
  --no-skill-list \
  --json >"${SMOKE_LOG_DIR}/inplace-doctor-json.log"; then
  cat "${SMOKE_LOG_DIR}/inplace-doctor-json.log" >&2
  fail "in-place doctor command failed"
fi
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.installMode !== "in-place") throw new Error(`unexpected installMode: ${data.installMode}`);
if (data.agent?.installMode !== "in-place") throw new Error(`unexpected agent.installMode: ${data.agent?.installMode}`);
if (!data.counts || data.counts.fail !== 0) throw new Error("in-place doctor JSON reported failures");
' "${SMOKE_LOG_DIR}/inplace-doctor-json.log"
pass "in-place doctor JSON accepted"

PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/scripts/pi67-status.sh" \
  --repo-root "$INPLACE_AGENT" \
  --agent-dir "$INPLACE_AGENT" \
  --skills-dir "$TMP_ROOT/inplace-shared-skills" \
  --no-remote \
  --json >"${SMOKE_LOG_DIR}/inplace-status-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.installMode !== "in-place") throw new Error(`unexpected status installMode: ${data.installMode}`);
if (data.agent?.installMode !== "in-place") throw new Error(`unexpected status agent.installMode: ${data.agent?.installMode}`);
if (data.sharedSkillPacks?.summary?.attention !== 0) throw new Error("in-place status shared Skill Pack should be consistent");
if (!["READY", "READY_WITH_WARNINGS"].includes(data.result)) throw new Error(`unexpected in-place status result: ${data.result}`);
' "${SMOKE_LOG_DIR}/inplace-status-json.log"
pass "in-place status JSON accepted"

section "Workspace-only configure boundary"
WORKSPACE_ONLY_AGENT="$TMP_ROOT/workspace-only-agent"
WORKSPACE_ONLY_SNAPSHOT="$TMP_ROOT/workspace-only-before.json"
cp -Rp "$INPLACE_AGENT" "$WORKSPACE_ONLY_AGENT"
node - "$WORKSPACE_ONLY_AGENT" "$WORKSPACE_ONLY_SNAPSHOT" <<'NODE'
const fs = require("fs");
const path = require("path");

const agentDir = process.argv[2];
const snapshotPath = process.argv[3];
const fixtures = {
  "settings.json": '{"defaultProvider":"anthropic","defaultModel":"claude-fixture","custom":"preserve-settings-bytes"}\n',
  "models.json": '{"providers":{"fixture":{"apiKey":"preserve-models-bytes"}}}\n',
  "auth.json": '{"anthropic":{"type":"api_key","key":"preserve-auth-bytes"}}\n',
  "image-gen.json": '{"provider":"fixture","apiKey":"preserve-image-config-bytes"}\n',
};

for (const [name, content] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(agentDir, name), content);
}
const snapshot = Object.fromEntries(
  Object.keys(fixtures).map((name) => [name, fs.readFileSync(path.join(agentDir, name)).toString("base64")]),
);
fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
NODE

PATH="$FAKE_BIN:$PATH" \
PI67_PROVIDER="xtalpi-pi-tools" \
PI67_MODEL="deepseek-v4-pro" \
PI67_XTALPI_API_KEY="ignored-workspace-only-xtalpi" \
PI67_CODEX_API_KEY="ignored-workspace-only-codex" \
PI67_DEEPSEEK_API_KEY="ignored-workspace-only-deepseek" \
PI67_IMAGE_GEN_API_KEY="ignored-workspace-only-image" \
"$REPO_ROOT/scripts/pi67-configure.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$WORKSPACE_ONLY_AGENT" \
  --workspace-only \
  --no-doctor >"${SMOKE_LOG_DIR}/workspace-only.log"

node - "$WORKSPACE_ONLY_AGENT" "$WORKSPACE_ONLY_SNAPSHOT" <<'NODE'
const fs = require("fs");
const path = require("path");

const agentDir = process.argv[2];
const snapshot = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
for (const [name, expected] of Object.entries(snapshot)) {
  const actual = fs.readFileSync(path.join(agentDir, name)).toString("base64");
  if (actual !== expected) {
    throw new Error(`--workspace-only changed upstream-owned state: ${name}`);
  }
}
JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8"));
NODE
pass "workspace-only configure preserves provider/model/auth state byte-for-byte"

section "Configure helper"
mkdir -p "$TMP_ROOT/browser67/src/mcp/browser" "$TMP_ROOT/browser67/src/mcp/js-reverse"
printf 'console.log("smoke tmwd server")\n' > "$TMP_ROOT/browser67/src/mcp/browser/server.mjs"
printf 'console.log("smoke js reverse server")\n' > "$TMP_ROOT/browser67/src/mcp/js-reverse/server.mjs"
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
  --provider xtalpi-pi-tools \
  --model deepseek-v4-pro \
  --codex-base-url "http://127.0.0.1:8317/v1" \
  --tmwd-repo "$TMP_ROOT/browser67" \
  --agent-memory-bin "$FAKE_BIN/agent-memory-mcp" \
  --image-gen-model "gpt-image-2" \
  --no-prompt \
  --no-doctor \
  --dry-run >"${SMOKE_LOG_DIR}/configure-dry.log"
pass "configure dry-run completed"

PATH="$FAKE_BIN:$PATH" \
PI67_XTALPI_API_KEY="smoke_xtalpi_api_key" \
PI67_CODEX_API_KEY="smoke_codex_api_key" \
PI67_DEEPSEEK_API_KEY="smoke_deepseek_api_key" \
PI67_IMAGE_GEN_API_KEY="smoke_image_gen_api_key" \
"$REPO_ROOT/scripts/pi67-configure.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --provider xtalpi-pi-tools \
  --model deepseek-v4-pro \
  --codex-base-url "http://127.0.0.1:8317/v1" \
  --tmwd-repo "$TMP_ROOT/browser67" \
  --agent-memory-bin "$FAKE_BIN/agent-memory-mcp" \
  --image-gen-model "gpt-image-2" \
  --no-prompt \
  --no-doctor >"${SMOKE_LOG_DIR}/configure.log"
pass "configure applied to temp install"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --agent-dir "$AGENT_DIR" >"${SMOKE_LOG_DIR}/doctor-configured.log"

node -e '
const fs = require("fs");
const path = require("path");
const mcp = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const tmwdCwd = mcp.mcpServers?.tmwd_browser?.cwd || "";
const jsCwd = mcp.mcpServers?.["js-reverse"]?.cwd || "";
const tmwdArg = mcp.mcpServers?.tmwd_browser?.args?.[0] || "";
const jsArg = mcp.mcpServers?.["js-reverse"]?.args?.[0] || "";
const memoryCommand = mcp.mcpServers?.agent_memory?.command || "";
for (const [label, value] of Object.entries({ tmwdCwd, jsCwd, tmwdArg, jsArg, memoryCommand })) {
  if (/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?:$|[\\/])/.test(value)) {
    throw new Error(`${label} kept an unsupported runtime placeholder: ${value}`);
  }
}
if (!path.isAbsolute(tmwdCwd) || !path.isAbsolute(jsCwd) || !path.isAbsolute(memoryCommand)) {
  throw new Error("configured MCP browser67 cwd and agent_memory command must be absolute");
}
if (tmwdArg !== "src/mcp/browser/server.mjs" || jsArg !== "src/mcp/js-reverse/server.mjs") {
  throw new Error("configured MCP browser67 args must stay cwd-relative");
}
' "$AGENT_DIR/mcp.json"
pass "configure writes adapter-runnable MCP cwd with relative browser67 args"

if grep -q 'Result: READY WITH WARNINGS' "${SMOKE_LOG_DIR}/doctor-configured.log"; then
  cat "${SMOKE_LOG_DIR}/doctor-configured.log" >&2
  fail "doctor still reported warnings after configure"
fi
if ! grep -q 'Result: READY' "${SMOKE_LOG_DIR}/doctor-configured.log"; then
  cat "${SMOKE_LOG_DIR}/doctor-configured.log" >&2
  fail "doctor did not report READY after configure"
fi
pass "doctor reports READY after configure"

DEEPSEEK_AGENT="$TMP_ROOT/deepseek-only-agent"
cp -Rp "$AGENT_DIR" "$DEEPSEEK_AGENT"
for state_file in settings.json models.json auth.json; do
  detached_state="$TMP_ROOT/deepseek-$state_file"
  cp -L "$DEEPSEEK_AGENT/$state_file" "$detached_state"
  rm -f "$DEEPSEEK_AGENT/$state_file"
  mv "$detached_state" "$DEEPSEEK_AGENT/$state_file"
done
node - "$DEEPSEEK_AGENT" <<'NODE'
const fs = require("fs");
const path = require("path");

const agentDir = process.argv[2];
const settingsPath = path.join(agentDir, "settings.json");
const modelsPath = path.join(agentDir, "models.json");
const authPath = path.join(agentDir, "auth.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));

settings.defaultProvider = "deepseek";
settings.defaultModel = "deepseek-v4-pro";
models.providers["xtalpi-pi-tools"].apiKey = "YOUR_XTALPI_API_KEY";
delete models.providers.deepseek;
auth.deepseek = { type: "api_key", key: "smoke-deepseek-upstream-auth" };

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
fs.writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
NODE

node - "$DEEPSEEK_AGENT" <<'NODE'
const fs = require("fs");
const path = require("path");

const agentDir = process.argv[2];
const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
if (settings.defaultProvider !== "deepseek" || settings.defaultModel !== "deepseek-v4-pro") {
  throw new Error("DeepSeek-only configure did not select the built-in provider");
}
if (models.providers?.deepseek) {
  throw new Error("DeepSeek built-in provider must not be duplicated in models.json");
}
if (!auth.deepseek?.key || /YOUR_|REPLACE_|placeholder|changeme/i.test(auth.deepseek.key)) {
  throw new Error("upstream DeepSeek auth fixture is invalid");
}
NODE

node "$REPO_ROOT/scripts/pi67-provider-status.mjs" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$DEEPSEEK_AGENT" \
  --json >"${SMOKE_LOG_DIR}/deepseek-provider-status.json"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.provider !== "deepseek" || data.model !== "deepseek-v4-pro" || data.ready !== true) {
  throw new Error("DeepSeek-only provider status is not ready");
}
if (data.checks.some((item) => item.level === "FAIL")) {
  throw new Error(`DeepSeek-only provider status reported failures: ${JSON.stringify(data.checks)}`);
}
' "${SMOKE_LOG_DIR}/deepseek-provider-status.json"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --agent-dir "$DEEPSEEK_AGENT" \
  --json >"${SMOKE_LOG_DIR}/deepseek-doctor.json"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.counts?.fail !== 0) {
  throw new Error(`DeepSeek-only doctor reported failures: ${JSON.stringify(data.checks)}`);
}
const messages = data.checks.map((item) => `${item.level}|${item.message}`).join("\n");
if (!messages.includes("PASS|upstream Pi owns the selected provider/model: deepseek/deepseek-v4-pro")) {
  throw new Error("doctor did not preserve the upstream DeepSeek selection boundary");
}
if (!messages.includes("PASS|provider deepseek credential is available via auth.json")) {
  throw new Error("doctor did not recognize upstream Pi auth.json readiness");
}
' "${SMOKE_LOG_DIR}/deepseek-doctor.json"
pass "read-only DeepSeek provider status and doctor contracts passed"

PI67_SMOKE_PI_LIST_WARNING=1 PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --agent-dir "$AGENT_DIR" \
  --json >"${SMOKE_LOG_DIR}/doctor-skill-warning-json.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const messages = data.checks.map((item) => item.message).join("\n");
if (!messages.includes("pi list reported package/resource warnings")) {
  throw new Error("doctor did not surface pi list package/resource warning");
}
if (data.counts.warn < 1) {
  throw new Error("doctor warning count did not include pi list warning");
}
' "${SMOKE_LOG_DIR}/doctor-skill-warning-json.log"
pass "doctor detects pi list package/resource warnings"

section "Deep MCP doctor probe"
cat > "$FAKE_BIN/fake-mcp-server" <<'SH'
#!/usr/bin/env node
let buffer = Buffer.alloc(0);
const separator = Buffer.from("\r\n\r\n");

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fake-mcp-server", version: "0.0.0-smoke" }
      }
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "smoke_echo",
            description: "Smoke-test tool",
            inputSchema: { type: "object", properties: {} }
          }
        ]
      }
    });
    setTimeout(() => process.exit(0), 25);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf(separator);
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + separator.length;
    const total = bodyStart + length;
    if (buffer.length < total) break;
    const body = buffer.subarray(bodyStart, total).toString("utf8");
    buffer = buffer.subarray(total);
    handle(JSON.parse(body));
  }
});
SH
chmod +x "$FAKE_BIN/fake-mcp-server"

cp "$AGENT_DIR/mcp.json" "$TMP_ROOT/mcp-configured.json"
cat > "$AGENT_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "fake_mcp": {
      "command": "$FAKE_BIN/fake-mcp-server",
      "args": [],
      "env": {}
    }
  }
}
JSON

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --deep-mcp \
  --mcp-timeout-ms 2000 \
  --json >"${SMOKE_LOG_DIR}/doctor-deep-mcp.log"
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaVersion !== 2) throw new Error(`unexpected doctor schemaVersion: ${data.schemaVersion}`);
if (data.schemaId !== "pi67-doctor/v2") throw new Error(`unexpected doctor schemaId: ${data.schemaId}`);
if (data.diagnostics?.deepMcp !== true) throw new Error("doctor diagnostics.deepMcp should be true");
if (data.result !== "READY") {
  throw new Error(`unexpected deep MCP result: ${data.result}`);
}
const messages = data.checks.map((item) => item.message).join("\n");
if (!messages.includes("MCP fake_mcp deep initialize succeeded")) {
  throw new Error("missing deep initialize success");
}
if (!messages.includes("MCP fake_mcp deep tools/list succeeded: 1 tools")) {
  throw new Error("missing deep tools/list success");
}
' "${SMOKE_LOG_DIR}/doctor-deep-mcp.log"

cat > "$AGENT_DIR/mcp.json" <<'JSON'
{
  "mcpServers": {
    "bad_mcp": {
      "command": "node",
      "args": [
        "$HOME/pi67-smoke-bad-mcp/server.mjs"
      ],
      "env": {}
    }
  }
}
JSON

if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --deep-mcp \
  --mcp-timeout-ms 2000 \
  --json >"${SMOKE_LOG_DIR}/doctor-deep-mcp-bad-path.log"; then
  cat "${SMOKE_LOG_DIR}/doctor-deep-mcp-bad-path.log" >&2
  fail "doctor deep MCP accepted unsupported $HOME arg placeholder"
fi
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const messages = data.checks.map((item) => item.message).join("\n");
if (data.result !== "FAIL") throw new Error(`bad MCP placeholder should fail deep doctor, got ${data.result}`);
if (!messages.includes("unsupported runtime placeholder")) {
  throw new Error("deep MCP doctor did not explain unsupported runtime placeholder");
}
' "${SMOKE_LOG_DIR}/doctor-deep-mcp-bad-path.log"
mv "$TMP_ROOT/mcp-configured.json" "$AGENT_DIR/mcp.json"
pass "doctor deep MCP probe completed and rejects adapter-incompatible placeholders"

section "Update helper"
UPDATE_REPO="$TMP_ROOT/update-repo"
UPDATE_REMOTE="$TMP_ROOT/update-remote.git"
git clone "$REPO_ROOT" "$UPDATE_REPO" >"${SMOKE_LOG_DIR}/update-clone.log" 2>&1
while IFS= read -r -d '' file; do
  if [ ! -e "$REPO_ROOT/$file" ] && [ ! -L "$REPO_ROOT/$file" ]; then
    continue
  fi
  mkdir -p "$UPDATE_REPO/$(dirname "$file")"
  cp -p "$REPO_ROOT/$file" "$UPDATE_REPO/$file"
done < <(git -C "$REPO_ROOT" ls-files -z --cached --others --exclude-standard)
while IFS= read -r -d '' file; do
  rm -f "$UPDATE_REPO/$file"
done < <(git -C "$REPO_ROOT" diff --cached --name-only --diff-filter=D -z)
git -C "$UPDATE_REPO" config user.email "pi67-smoke@example.invalid"
git -C "$UPDATE_REPO" config user.name "pi67 smoke"
git -C "$UPDATE_REPO" add .
git -C "$UPDATE_REPO" add -u
if ! git -C "$UPDATE_REPO" diff --cached --quiet; then
  git -C "$UPDATE_REPO" commit -q -m "pi67 smoke update candidate"
fi
if [ "$(git -C "$UPDATE_REPO" rev-parse --abbrev-ref HEAD)" = "HEAD" ]; then
  git -C "$UPDATE_REPO" switch -q -c pi67-smoke-update
fi
UPDATE_BRANCH="$(git -C "$UPDATE_REPO" rev-parse --abbrev-ref HEAD)"
git clone --bare "$UPDATE_REPO" "$UPDATE_REMOTE" >>"${SMOKE_LOG_DIR}/update-clone.log" 2>&1
git -C "$UPDATE_REPO" remote set-url origin "$UPDATE_REMOTE"
git -C "$UPDATE_REPO" fetch -q origin "$UPDATE_BRANCH"
git -C "$UPDATE_REPO" branch --set-upstream-to="origin/$UPDATE_BRANCH" "$UPDATE_BRANCH" >/dev/null
cp "$REPO_ROOT/scripts/pi67-report.sh" "$UPDATE_REPO/scripts/pi67-report.sh"
cp "$REPO_ROOT/scripts/pi67-configure.sh" "$UPDATE_REPO/scripts/pi67-configure.sh"
chmod +x "$UPDATE_REPO/scripts/pi67-report.sh"
chmod +x "$UPDATE_REPO/scripts/pi67-configure.sh"
if [ -f "$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs" ]; then
  cp "$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs" "$UPDATE_REPO/scripts/pi67-xtalpi-smoke-status-core.cjs"
fi

"$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-npm \
  --no-doctor \
  --no-report \
  --check-only >"${SMOKE_LOG_DIR}/update-check.log" 2>&1
if ! grep -q 'check-only completed without writing files' "${SMOKE_LOG_DIR}/update-check.log"; then
  cat "${SMOKE_LOG_DIR}/update-check.log" >&2
  fail "update check-only did not complete"
fi
pass "update check-only completed"

if ! "$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-npm \
  --no-doctor \
  --allow-dirty \
  --dry-run >"${SMOKE_LOG_DIR}/update-dry.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/update-dry.log" >&2
  fail "update dry-run failed"
fi
pass "update dry-run completed"

if ! "$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-npm \
  --no-doctor \
  --allow-dirty >"${SMOKE_LOG_DIR}/update.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/update.log" >&2
  fail "update helper command failed"
fi

if ! grep -q 'already up to date\|update finished' "${SMOKE_LOG_DIR}/update.log"; then
  cat "${SMOKE_LOG_DIR}/update.log" >&2
  fail "update helper did not complete cleanly"
fi
if ! grep -Eq 'git=[0-9]+s config=[0-9]+s skills=[0-9]+s npm=[0-9]+s verify=[0-9]+s total=[0-9]+s' "${SMOKE_LOG_DIR}/update.log"; then
  cat "${SMOKE_LOG_DIR}/update.log" >&2
  fail "update helper did not report phase timings"
fi
pass "update helper completed on temp checkout"

UPDATE_HOME="$TMP_ROOT/update-home"
mkdir -p "$UPDATE_HOME"
UPDATE_BACKUP_ROOT="$UPDATE_HOME/.pi/pi67/backups"
backup_count_before="$(count_backup_dirs "$UPDATE_BACKUP_ROOT")"
for runtime_state_file in \
  .gitignore \
  settings.example.json \
  packages/pi67-cli/src/lib/settings-runtime-clean.mjs \
  packages/pi67-cli/src/lib/settings-runtime-state.mjs \
  packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs
do
  mkdir -p "$UPDATE_REPO/$(dirname "$runtime_state_file")"
  cp "$REPO_ROOT/$runtime_state_file" "$UPDATE_REPO/$runtime_state_file"
done
git -C "$UPDATE_REPO" config user.email pi67-smoke@example.invalid
git -C "$UPDATE_REPO" config user.name pi67-smoke
git -C "$UPDATE_REPO" add .gitignore settings.example.json scripts/pi67-configure.sh scripts/pi67-report.sh packages/pi67-cli/src/lib/settings-runtime-clean.mjs packages/pi67-cli/src/lib/settings-runtime-state.mjs packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs
if ! git -C "$UPDATE_REPO" diff --cached --quiet; then
  git -C "$UPDATE_REPO" commit -q -m "smoke runtime-state baseline"
fi
cp "$UPDATE_REPO/settings.example.json" "$UPDATE_REPO/settings.json"
git -C "$UPDATE_REPO" check-ignore -q settings.json \
  || fail "settings runtime fixture is not ignored"
node -e '
const fs = require("fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data.lastChangelogVersion = "pi67-smoke-runtime-marker";
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
' "$UPDATE_REPO/settings.json"
if ! HOME="$UPDATE_HOME" "$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$UPDATE_REPO" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-npm \
  --no-configure \
  --no-doctor \
  --no-report >"${SMOKE_LOG_DIR}/update-runtime-no-backup.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/update-runtime-no-backup.log" >&2
  fail "up-to-date dirty runtime update failed"
fi
backup_count_after="$(count_backup_dirs "$UPDATE_BACKUP_ROOT")"
if [ "$backup_count_after" != "$backup_count_before" ]; then
  cat "${SMOKE_LOG_DIR}/update-runtime-no-backup.log" >&2
  fail "up-to-date dirty runtime update created a backup"
fi
if ! grep -q 'settings runtime state (preflight)' "${SMOKE_LOG_DIR}/update-runtime-no-backup.log"; then
  cat "${SMOKE_LOG_DIR}/update-runtime-no-backup.log" >&2
  fail "ignored settings update did not run runtime-state migration"
fi
node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
const statePath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (Object.prototype.hasOwnProperty.call(settings, "lastChangelogVersion")) {
  throw new Error("settings.json still contains runtime marker");
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.runtimeMarkers?.lastChangelogVersion?.value !== "pi67-smoke-runtime-marker") {
  throw new Error("state.json did not preserve runtime marker");
}
' "$UPDATE_REPO/settings.json" "$UPDATE_HOME/.pi/pi67/state.json"
git -C "$UPDATE_REPO" check-ignore -q settings.json \
  || fail "settings.json stopped being ignored after runtime migration"
if [ -n "$(git -C "$UPDATE_REPO" status --short -- settings.json)" ]; then
  fail "ignored settings runtime state appeared in Git status"
fi
if git -C "$UPDATE_REPO" config --local --get-regexp '^filter\.pi67-settings-runtime-state\.' >/dev/null 2>&1; then
  fail "legacy settings Git filter remained after untracked runtime migration"
fi
pass "ignored settings runtime marker migrated without backup or Git dirtiness"

cat > "$UPDATE_REPO/scripts/pi67-report.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

agent_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir)
      agent_dir="${2:?--agent-dir requires a path}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -z "$agent_dir" ]; then
  echo "missing --agent-dir" >&2
  exit 2
fi

node - "$agent_dir/settings.json" "$agent_dir/pi67-report.json" <<'NODE'
const fs = require("fs");
const [, , settingsPath, reportPath] = process.argv;
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.lastChangelogVersion = "pi67-smoke-final-marker";
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
fs.writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      schemaVersion: 2,
      generatedAt: new Date(0).toISOString(),
      pi67Version: "smoke",
      repository: { shortCommit: "smoke", dirty: true }
    },
    null,
    2
  )}\n`
);
NODE
SH
chmod +x "$UPDATE_REPO/scripts/pi67-report.sh"
git -C "$UPDATE_REPO" add scripts/pi67-report.sh
if ! git -C "$UPDATE_REPO" diff --cached --quiet; then
  git -C "$UPDATE_REPO" commit -q -m "smoke final-marker report fixture"
fi

if ! HOME="$UPDATE_HOME" "$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$UPDATE_REPO" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --no-npm \
  --no-configure \
  --no-doctor >"${SMOKE_LOG_DIR}/update-runtime-final.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/update-runtime-final.log" >&2
  fail "update helper final runtime migration failed"
fi
if ! grep -q 'settings runtime state (final)' "${SMOKE_LOG_DIR}/update-runtime-final.log"; then
  cat "${SMOKE_LOG_DIR}/update-runtime-final.log" >&2
  fail "update helper did not run final settings runtime migration"
fi
node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
const statePath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (Object.prototype.hasOwnProperty.call(settings, "lastChangelogVersion")) {
  throw new Error("settings.json still contains final runtime marker");
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.runtimeMarkers?.lastChangelogVersion?.value !== "pi67-smoke-final-marker") {
  throw new Error("state.json did not preserve final runtime marker");
}
' "$UPDATE_REPO/settings.json" "$UPDATE_HOME/.pi/pi67/state.json"
if [ -n "$(git -C "$UPDATE_REPO" status --short -- settings.json)" ]; then
  fail "final ignored settings migration dirtied Git status"
fi
pass "update final step normalizes settings runtime marker written after preflight"

UPDATE_CONFLICT_SKILLS="$TMP_ROOT/update-conflict-shared-skills"
mkdir -p "$UPDATE_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME"
printf '# Existing newer global skill\n' > "$UPDATE_CONFLICT_SKILLS/$FIRST_SHARED_SKILL_NAME/SKILL.md"
"$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$UPDATE_CONFLICT_SKILLS" \
  --no-npm \
  --no-doctor \
  --no-report \
  --allow-dirty >"${SMOKE_LOG_DIR}/update-conflict.log" 2>&1
if ! grep -q "preserved 1 user-modified global Skills: $FIRST_SHARED_SKILL_NAME" "${SMOKE_LOG_DIR}/update-conflict.log"; then
  cat "${SMOKE_LOG_DIR}/update-conflict.log" >&2
  fail "update did not keep existing different shared skill"
fi
if grep -q 'dirHash=' "${SMOKE_LOG_DIR}/update-conflict.log"; then
  cat "${SMOKE_LOG_DIR}/update-conflict.log" >&2
  fail "default update drift output exposed verbose per-Skill hashes"
fi
pass "update keeps existing different shared skills by default"

if "$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --skills-dir "$UPDATE_CONFLICT_SKILLS" \
  --no-npm \
  --no-doctor \
  --no-report \
  --strict-shared-skills \
  --allow-dirty >"${SMOKE_LOG_DIR}/update-strict-conflict.log" 2>&1; then
  cat "${SMOKE_LOG_DIR}/update-strict-conflict.log" >&2
  fail "update strict shared skill mode accepted a conflict"
fi
pass "update strict shared skill mode blocks conflicts"

node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.schemaVersion !== 2) throw new Error(`unexpected report schemaVersion: ${report.schemaVersion}`);
if (report.schemaId !== "pi67-report/v2") throw new Error(`unexpected report schemaId: ${report.schemaId}`);
if (report.operation !== "update") throw new Error(`unexpected report operation: ${report.operation}`);
if (report.pi67?.version !== report.pi67Version) throw new Error("pi67.version does not match legacy pi67Version");
if (!report.reportPolicy?.currentFileOverwritten) throw new Error("report overwrite policy missing");
if (report.doctor?.skipped !== true) throw new Error("update --no-doctor report should mark doctor skipped");
' "$AGENT_DIR/pi67-report.json"
pass "update report JSON written"

section "Restore/uninstall operations"
OPS_AGENT="$TMP_ROOT/ops-agent"
OPS_BACKUP="$TMP_ROOT/ops-backup"
mkdir -p "$OPS_AGENT/skills"
printf 'old agents\n' > "$OPS_AGENT/AGENTS.md"
printf 'old skill\n' > "$OPS_AGENT/skills/old.txt"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$OPS_AGENT" \
  --skills-dir "$TMP_ROOT/ops-shared-skills" \
  --backup-dir "$OPS_BACKUP" \
  --no-npm \
  --no-doctor \
  --yes >"${SMOKE_LOG_DIR}/ops-install.log"

if [ -e "$OPS_AGENT/skills" ] || [ -L "$OPS_AGENT/skills" ]; then
  cat "${SMOKE_LOG_DIR}/ops-install.log" >&2
  fail "install did not retire legacy agent skills"
fi
if [ ! -f "$OPS_BACKUP/skills/old.txt" ]; then
  cat "${SMOKE_LOG_DIR}/ops-install.log" >&2
  fail "install did not back up legacy agent skills"
fi

"$REPO_ROOT/scripts/pi67-restore.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$OPS_BACKUP" \
  --dry-run >"${SMOKE_LOG_DIR}/restore-dry.log"

"$REPO_ROOT/scripts/pi67-restore.sh" \
  --agent-dir "$OPS_AGENT" \
  --backup-dir "$OPS_BACKUP" \
  --yes >"${SMOKE_LOG_DIR}/restore.log"

if [ "$(cat "$OPS_AGENT/AGENTS.md")" != "old agents" ] || [ ! -f "$OPS_AGENT/skills/old.txt" ]; then
  fail "restore did not recover preinstall files"
fi
pass "restore recovered preinstall files"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/install.sh" \
  --agent-dir "$OPS_AGENT" \
  --skills-dir "$TMP_ROOT/ops-shared-skills-2" \
  --backup-dir "$TMP_ROOT/ops-backup-2" \
  --no-npm \
  --no-doctor \
  --yes >"${SMOKE_LOG_DIR}/ops-install-2.log"

"$REPO_ROOT/scripts/pi67-uninstall.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$OPS_AGENT" \
  --dry-run >"${SMOKE_LOG_DIR}/uninstall-dry.log"

"$REPO_ROOT/scripts/pi67-uninstall.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$OPS_AGENT" \
  --yes >"${SMOKE_LOG_DIR}/uninstall.log"

if [ -e "$OPS_AGENT/AGENTS.md" ] || [ ! -f "$OPS_AGENT/models.json" ]; then
  fail "uninstall did not remove owned symlinks while preserving local config"
fi
pass "uninstall removed owned symlinks and preserved local config"

section "Summary"
pass "pi-67 smoke passed"
