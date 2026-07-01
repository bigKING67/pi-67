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
    /tmp/pi67-smoke-release-dry.log \
    /tmp/pi67-smoke-secrets.log \
    /tmp/pi67-smoke-install.log \
    /tmp/pi67-smoke-doctor.log \
    /tmp/pi67-smoke-doctor-quiet.log \
    /tmp/pi67-smoke-doctor-json.log \
    /tmp/pi67-smoke-doctor-deep-mcp.log \
    /tmp/pi67-smoke-status.log \
    /tmp/pi67-smoke-status-json.log \
    /tmp/pi67-smoke-skill-audit.log \
    /tmp/pi67-smoke-skill-audit-json.log \
    /tmp/pi67-smoke-inplace-install.log \
    /tmp/pi67-smoke-inplace-doctor-json.log \
    /tmp/pi67-smoke-inplace-status-json.log \
    /tmp/pi67-smoke-configure-dry.log \
    /tmp/pi67-smoke-configure.log \
    /tmp/pi67-smoke-doctor-configured.log \
    /tmp/pi67-smoke-ops-install.log \
    /tmp/pi67-smoke-restore-dry.log \
    /tmp/pi67-smoke-restore.log \
    /tmp/pi67-smoke-ops-install-2.log \
    /tmp/pi67-smoke-update-clone.log \
    /tmp/pi67-smoke-update-check.log \
    /tmp/pi67-smoke-update-dry.log \
    /tmp/pi67-smoke-update.log \
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
bash -n "$REPO_ROOT/scripts/pi67-release.sh"
bash -n "$REPO_ROOT/scripts/pi67-release-check.sh"
bash -n "$REPO_ROOT/scripts/pi67-report.sh"
if [ -f "$REPO_ROOT/scripts/pi67-skill-audit.sh" ]; then
  bash -n "$REPO_ROOT/scripts/pi67-skill-audit.sh"
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

"$REPO_ROOT/scripts/pi67-release.sh" \
  --dry-run \
  --no-smoke \
  --no-github-release >/tmp/pi67-smoke-release-dry.log
if ! grep -q 'dry-run completed' /tmp/pi67-smoke-release-dry.log; then
  cat /tmp/pi67-smoke-release-dry.log >&2
  fail "release automation dry-run did not complete"
fi
pass "release automation dry-run completed"

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

section "Portability scan"
PERSONAL_HOME_PREFIX_PART_A="/Use"
PERSONAL_HOME_PREFIX_PART_B="rs/"
PERSONAL_USER_PART_A="gao"
PERSONAL_USER_PART_B="qian"
PERSONAL_WORKSPACE_PART_A="six"
PERSONAL_WORKSPACE_PART_B="seven"
PORTABILITY_PATTERN="${PERSONAL_HOME_PREFIX_PART_A}${PERSONAL_HOME_PREFIX_PART_B}${PERSONAL_USER_PART_A}${PERSONAL_USER_PART_B}|Documents/${PERSONAL_WORKSPACE_PART_A}${PERSONAL_WORKSPACE_PART_B}|${PERSONAL_USER_PART_A}${PERSONAL_USER_PART_B}"
if git -C "$REPO_ROOT" grep -n -E "$PORTABILITY_PATTERN" -- . >/tmp/pi67-smoke-portability.log 2>/dev/null; then
  cat /tmp/pi67-smoke-portability.log >&2
  fail "personal machine paths found in repository content"
fi
rm -f /tmp/pi67-smoke-portability.log
pass "no personal machine paths"

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

if [ ! -f "$AGENT_DIR/pi67-report.json" ]; then
  cat /tmp/pi67-smoke-install.log >&2
  fail "install did not write pi67-report.json"
fi
node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.schemaVersion !== 2) throw new Error(`unexpected report schemaVersion: ${report.schemaVersion}`);
if (report.schemaId !== "pi67-report/v2") throw new Error(`unexpected report schemaId: ${report.schemaId}`);
if (report.operation !== "install") throw new Error(`unexpected report operation: ${report.operation}`);
if (report.pi67?.version !== report.pi67Version) throw new Error("pi67.version does not match legacy pi67Version");
if (!report.reportPolicy?.currentFileOverwritten) throw new Error("report overwrite policy missing");
if (report.doctor?.skipped !== true) throw new Error("install --no-doctor report should mark doctor skipped");
' "$AGENT_DIR/pi67-report.json"
pass "install report JSON written"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" >/tmp/pi67-smoke-doctor.log
pass "doctor completed on temp install"

if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' /tmp/pi67-smoke-doctor.log; then
  cat /tmp/pi67-smoke-doctor.log >&2
  fail "doctor did not report a ready result"
fi
pass "doctor readiness result accepted"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --quiet >/tmp/pi67-smoke-doctor-quiet.log
if grep -q -- '--- Core tools ---' /tmp/pi67-smoke-doctor-quiet.log; then
  cat /tmp/pi67-smoke-doctor-quiet.log >&2
  fail "doctor --quiet printed detailed sections"
fi
if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' /tmp/pi67-smoke-doctor-quiet.log; then
  cat /tmp/pi67-smoke-doctor-quiet.log >&2
  fail "doctor --quiet did not report a ready result"
fi
pass "doctor quiet output completed"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-doctor.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --json >/tmp/pi67-smoke-doctor-json.log
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
' /tmp/pi67-smoke-doctor-json.log
pass "doctor JSON output parsed"

section "Status summary"
PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-status.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --no-remote >/tmp/pi67-smoke-status.log
if ! grep -q 'Result: READY WITH WARNINGS\|Result: READY' /tmp/pi67-smoke-status.log; then
  cat /tmp/pi67-smoke-status.log >&2
  fail "status text output did not complete"
fi
pass "status text output completed"

PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/pi67-status.sh" \
  --repo-root "$REPO_ROOT" \
  --agent-dir "$AGENT_DIR" \
  --no-remote \
  --json >/tmp/pi67-smoke-status-json.log
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaVersion !== 1) throw new Error(`unexpected status schemaVersion: ${data.schemaVersion}`);
if (data.schemaId !== "pi67-status/v1") throw new Error(`unexpected status schemaId: ${data.schemaId}`);
if (data.report?.schemaId !== "pi67-report/v2") throw new Error("status did not read report schema v2");
if (data.report?.stale !== false) throw new Error(`status reported stale report: ${(data.report?.staleReasons || []).join("; ")}`);
if (!Array.isArray(data.recommendations) || data.recommendations.length === 0) {
  throw new Error("status recommendations missing");
}
' /tmp/pi67-smoke-status-json.log
pass "status JSON output parsed"

section "Skill audit helper"
mkdir -p "$TMP_ROOT/skill-audit-agent/skills" "$TMP_ROOT/external-skills"
printf 'full-output-enforcement\nlegacy-missing\n' > "$TMP_ROOT/legacy-skills.txt"
printf 'legacy-missing -> ../../../.agents/skills/legacy-missing\n' > "$TMP_ROOT/legacy-links.txt"

bash "$REPO_ROOT/scripts/pi67-skill-audit.sh" \
  --agent-dir "$TMP_ROOT/skill-audit-agent" \
  --legacy-names "$TMP_ROOT/legacy-skills.txt" \
  --legacy-links "$TMP_ROOT/legacy-links.txt" \
  --skill-root "$TMP_ROOT/external-skills" >/tmp/pi67-smoke-skill-audit.log
pass "skill audit text output completed"

bash "$REPO_ROOT/scripts/pi67-skill-audit.sh" \
  --agent-dir "$TMP_ROOT/skill-audit-agent" \
  --legacy-names "$TMP_ROOT/legacy-skills.txt" \
  --legacy-links "$TMP_ROOT/legacy-links.txt" \
  --skill-root "$TMP_ROOT/external-skills" \
  --json >/tmp/pi67-smoke-skill-audit-json.log
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.schemaId !== "pi67-skill-audit/v1") throw new Error(`unexpected schemaId: ${data.schemaId}`);
if (!data.repository || data.repository.skillCount < 1) throw new Error("missing repository skills");
const missing = data.legacy?.legacyOnly?.find((entry) => entry.name === "legacy-missing");
if (!missing) throw new Error("missing legacy-only skill audit entry");
if (missing.classification !== "stale_broken_link") throw new Error(`unexpected classification: ${missing.classification}`);
' /tmp/pi67-smoke-skill-audit-json.log
pass "skill audit JSON output parsed"

section "Temp in-place install"
INPLACE_AGENT="$TMP_ROOT/in-place-agent"
mkdir -p "$INPLACE_AGENT"

while IFS= read -r -d '' file; do
  mkdir -p "$INPLACE_AGENT/$(dirname "$file")"
  cp -p "$REPO_ROOT/$file" "$INPLACE_AGENT/$file"
done < <(git -C "$REPO_ROOT" ls-files -z)

git -C "$INPLACE_AGENT" init -q
git -C "$INPLACE_AGENT" config user.email "pi67-smoke@example.invalid"
git -C "$INPLACE_AGENT" config user.name "pi67 smoke"
git -C "$INPLACE_AGENT" add .
git -C "$INPLACE_AGENT" commit -q -m "pi67 smoke in-place baseline"

PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/install.sh" \
  --agent-dir "$INPLACE_AGENT" \
  --no-npm \
  --no-doctor \
  --yes >/tmp/pi67-smoke-inplace-install.log
pass "temp in-place install completed"

if [ -L "$INPLACE_AGENT/AGENTS.md" ]; then
  cat /tmp/pi67-smoke-inplace-install.log >&2
  fail "in-place install turned AGENTS.md into a symlink"
fi
for path in AGENTS.md rules scripts skills docs prompts extensions templates; do
  if [ ! -e "$INPLACE_AGENT/$path" ]; then
    fail "in-place install removed tracked asset: $path"
  fi
done
if find "$INPLACE_AGENT" -maxdepth 1 -name 'backup-*' -print -quit | grep -q .; then
  fail "in-place install created an asset backup directory"
fi
pass "in-place tracked assets preserved"

for path in models.json mcp.json auth.json image-gen.json pi67-report.json; do
  if [ ! -e "$INPLACE_AGENT/$path" ]; then
    fail "in-place install did not create local file: $path"
  fi
  git -C "$INPLACE_AGENT" check-ignore -q "$path" || fail "in-place local file is not ignored: $path"
done
pass "in-place local files created and ignored"

PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/scripts/pi67-doctor.sh" \
  --repo-root "$INPLACE_AGENT" \
  --agent-dir "$INPLACE_AGENT" \
  --no-skill-list \
  --json >/tmp/pi67-smoke-inplace-doctor-json.log
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.installMode !== "in-place") throw new Error(`unexpected installMode: ${data.installMode}`);
if (data.agent?.installMode !== "in-place") throw new Error(`unexpected agent.installMode: ${data.agent?.installMode}`);
if (!data.counts || data.counts.fail !== 0) throw new Error("in-place doctor JSON reported failures");
' /tmp/pi67-smoke-inplace-doctor-json.log
pass "in-place doctor JSON accepted"

PATH="$FAKE_BIN:$PATH" "$INPLACE_AGENT/scripts/pi67-status.sh" \
  --repo-root "$INPLACE_AGENT" \
  --agent-dir "$INPLACE_AGENT" \
  --no-remote \
  --json >/tmp/pi67-smoke-inplace-status-json.log
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.installMode !== "in-place") throw new Error(`unexpected status installMode: ${data.installMode}`);
if (data.agent?.installMode !== "in-place") throw new Error(`unexpected status agent.installMode: ${data.agent?.installMode}`);
if (!["READY", "READY_WITH_WARNINGS"].includes(data.result)) throw new Error(`unexpected in-place status result: ${data.result}`);
' /tmp/pi67-smoke-inplace-status-json.log
pass "in-place status JSON accepted"

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
  --deep-mcp \
  --mcp-timeout-ms 2000 \
  --json >/tmp/pi67-smoke-doctor-deep-mcp.log
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
' /tmp/pi67-smoke-doctor-deep-mcp.log
mv "$TMP_ROOT/mcp-configured.json" "$AGENT_DIR/mcp.json"
pass "doctor deep MCP probe completed"

section "Update helper"
UPDATE_REPO="$TMP_ROOT/update-repo"
git clone "$REPO_ROOT" "$UPDATE_REPO" >/tmp/pi67-smoke-update-clone.log 2>&1
cp "$REPO_ROOT/scripts/pi67-report.sh" "$UPDATE_REPO/scripts/pi67-report.sh"
chmod +x "$UPDATE_REPO/scripts/pi67-report.sh"

"$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --no-npm \
  --no-doctor \
  --no-report \
  --check-only >/tmp/pi67-smoke-update-check.log 2>&1
if ! grep -q 'check-only completed without writing files' /tmp/pi67-smoke-update-check.log; then
  cat /tmp/pi67-smoke-update-check.log >&2
  fail "update check-only did not complete"
fi
pass "update check-only completed"

"$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --no-npm \
  --no-doctor \
  --allow-dirty \
  --dry-run >/tmp/pi67-smoke-update-dry.log 2>&1
pass "update dry-run completed"

"$REPO_ROOT/scripts/pi67-update.sh" \
  --repo-root "$UPDATE_REPO" \
  --agent-dir "$AGENT_DIR" \
  --no-npm \
  --no-doctor \
  --allow-dirty >/tmp/pi67-smoke-update.log 2>&1

if ! grep -q 'already up to date\|update finished' /tmp/pi67-smoke-update.log; then
  cat /tmp/pi67-smoke-update.log >&2
  fail "update helper did not complete cleanly"
fi
pass "update helper completed on temp checkout"

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
