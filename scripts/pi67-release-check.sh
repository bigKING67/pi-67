#!/usr/bin/env bash
set -euo pipefail

# Fast release metadata consistency check.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

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

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

echo ""
echo -e "${CYAN}pi-67 release check${NC}"
echo "Repository: $REPO_ROOT"

VERSION_FILE="$REPO_ROOT/VERSION"
CHANGELOG="$REPO_ROOT/CHANGELOG.md"
PACKAGE_JSON="$REPO_ROOT/package.json"
PI67_CLI_DIR="$REPO_ROOT/packages/pi67-cli"
PI67_CLI_PACKAGE_JSON="$PI67_CLI_DIR/package.json"
PI67_CLI_BIN="$PI67_CLI_DIR/bin/pi-67.mjs"
PI67_CLI_SOURCE="$PI67_CLI_DIR/src/cli.mjs"
PI67_XTALPI_COMMAND="$PI67_CLI_DIR/src/commands/xtalpi.mjs"
RELEASE_DOC="$REPO_ROOT/docs/release.md"
WINDOWS_FRESH_INSTALL_DOC="$REPO_ROOT/docs/windows-fresh-install.md"
NPM_PUBLISH_WORKFLOW="$REPO_ROOT/.github/workflows/npm-publish.yml"
REPORT_SCHEMA_DOC="$REPO_ROOT/docs/report-schema.md"
DOCTOR_SCHEMA_DOC="$REPO_ROOT/docs/doctor-schema.md"
STATUS_DOC="$REPO_ROOT/docs/status.md"
SKILL_MIGRATION_SCHEMA_DOC="$REPO_ROOT/docs/skill-migration-schema.md"
EXTERNAL_SKILL_SYNC_SCHEMA_DOC="$REPO_ROOT/docs/external-skill-sync-schema.md"
FULL_INSTALL_DOC="$REPO_ROOT/docs/full-install.md"
SKILL_GOV_DOC="$REPO_ROOT/docs/skill-governance.md"
TROUBLESHOOTING_DOC="$REPO_ROOT/docs/troubleshooting.md"
XTALPI_PI_TOOLS_DOC="$REPO_ROOT/docs/xtalpi-pi-tools.md"
SKILL_GOVERNANCE_TEST="$REPO_ROOT/scripts/pi67-test-skill-governance.sh"
EXTERNAL_SKILLS_CHECK="$REPO_ROOT/scripts/pi67-check-external-skills.sh"
COMMERCE_GROWTH_SYNC="$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh"
RELEASE_ARTIFACT_SMOKE="$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh"
RELEASE_SCRIPT="$REPO_ROOT/scripts/pi67-release.sh"
XTALPI_PI_TOOLS_SCRIPT="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools.sh"
XTALPI_PI_TOOLS_SCRIPT_PS="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools.ps1"
XTALPI_PI_TOOLS_TEST="$REPO_ROOT/scripts/pi67-test-xtalpi-pi-tools.sh"
XTALPI_PI_TOOLS_SMOKE="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-smoke.sh"
XTALPI_PI_TOOLS_SMOKE_PS="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-smoke.ps1"
XTALPI_PI_TOOLS_DEBUG_SUMMARY="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-debug-summary.sh"
XTALPI_PI_TOOLS_SMOKE_STATUS_CORE="$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs"
XTALPI_PI_TOOLS_SMOKE_PLAN="$REPO_ROOT/scripts/pi67-xtalpi-smoke-plan.mjs"
XTALPI_PI_TOOLS_PROVIDER_HEALTH="$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs"
XTALPI_PI_TOOLS_CAPABILITY_PROBE="$REPO_ROOT/scripts/pi67-xtalpi-provider-capability-probe.mjs"
XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK="$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs"
XTALPI_PI_TOOLS_COVERAGE_AUDIT="$REPO_ROOT/scripts/pi67-xtalpi-tool-coverage-audit.sh"
XTALPI_PI_TOOLS_REPLAY_FIXTURES="$REPO_ROOT/extensions/xtalpi-pi-tools/fixtures/replay-cases.json"
XTALPI_PI_TOOLS_ERROR_CONTRACT="$REPO_ROOT/extensions/xtalpi-pi-tools/provider-error-contract.json"
XTALPI_PI_TOOLS_JSON_FILE="$REPO_ROOT/extensions/xtalpi-pi-tools/json-file.ts"
XTALPI_PI_TOOLS_JSON_ACTION_PROTOCOL="$REPO_ROOT/extensions/xtalpi-pi-tools/json-action-protocol.ts"
XTALPI_PI_TOOLS_RUNTIME_CONFIG="$REPO_ROOT/extensions/xtalpi-pi-tools/runtime-config.ts"
JSON_UTIL_CJS="$REPO_ROOT/scripts/pi67-json-utils.cjs"
JSON_UTIL_PS="$REPO_ROOT/scripts/pi67-json-utils.ps1"
MCP_CONFIG_UTIL_CJS="$REPO_ROOT/scripts/pi67-mcp-config-utils.cjs"
POWERSHELL_SMOKE="$REPO_ROOT/scripts/pi67-smoke.ps1"
POWERSHELL_BOOTSTRAP="$REPO_ROOT/scripts/pi67-bootstrap.ps1"
POWERSHELL_UPDATE="$REPO_ROOT/scripts/pi67-update.ps1"
POWERSHELL_ACCEPTANCE="$REPO_ROOT/scripts/pi67-windows-acceptance.ps1"
POWERSHELL_DOCTOR="$REPO_ROOT/scripts/pi67-doctor.ps1"
POWERSHELL_REPORT="$REPO_ROOT/scripts/pi67-report.ps1"
UNTIL_DONE_QUEUE_PATCH_MJS="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs"
UNTIL_DONE_QUEUE_PATCH_SH="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh"
UNTIL_DONE_QUEUE_PATCH_PS="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.ps1"
XTALPI_CONFIG_LIB="$REPO_ROOT/packages/pi67-cli/src/lib/xtalpi-config.mjs"
PROVIDER_STATUS_SCRIPT="$REPO_ROOT/scripts/pi67-provider-status.mjs"

if [ -f "$VERSION_FILE" ]; then
  VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
  if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    pass "VERSION is semver-like: $VERSION"
  else
    fail "VERSION is not semver-like: $VERSION"
  fi
else
  VERSION=""
  fail "missing VERSION"
fi

if command_exists node; then
  PACKAGE_VERSION="$(node -e 'const pkg=require(process.argv[1]); console.log(pkg.version || "")' "$PACKAGE_JSON" 2>/dev/null || true)"
  if [ -z "$PACKAGE_VERSION" ]; then
    fail "package.json missing version"
  elif [ "$PACKAGE_VERSION" = "$VERSION" ]; then
    pass "package.json version matches VERSION"
  else
    fail "package.json version ($PACKAGE_VERSION) does not match VERSION ($VERSION)"
  fi
else
  warn "node not found; skipped package.json version check"
fi

if [ -d "$PI67_CLI_DIR" ] && [ -f "$PI67_CLI_PACKAGE_JSON" ] && [ -f "$PI67_CLI_BIN" ]; then
  pass "pi-67 npm CLI package files exist"
else
  fail "pi-67 npm CLI package files are missing under packages/pi67-cli"
fi

if command_exists node; then
  if node - "$PI67_CLI_PACKAGE_JSON" "$VERSION" <<'NODE'
const fs = require("fs");
const [pkgFile, version] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(pkg.name === "@bigking67/pi-67", `unexpected CLI package name: ${pkg.name}`);
assert(pkg.version === version, `CLI package version ${pkg.version} does not match VERSION ${version}`);
assert(pkg.type === "module", "CLI package must be ESM");
assert(pkg.bin?.["pi-67"] === "bin/pi-67.mjs", "CLI package must expose pi-67 bin");
assert(pkg.bin?.pi67 === "bin/pi-67.mjs", "CLI package must expose pi67 alias");
assert(pkg.publishConfig?.access === "public", "scoped CLI package must publish as public");
assert(pkg.scripts?.prepublishOnly?.includes("publish-check"), "CLI package must run publish-check before npm publish");
NODE
  then
    pass "pi-67 npm CLI package metadata is valid"
  else
    fail "pi-67 npm CLI package metadata is invalid"
  fi

  while IFS= read -r -d '' file; do
    node --check "$file" >/dev/null
  done < <(find "$PI67_CLI_DIR" -type f -name '*.mjs' -print0)
  pass "pi-67 npm CLI JavaScript syntax checks passed"

  node "$PI67_CLI_BIN" --help >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" version --json >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" manifest --json >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" manifest --validate >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" extensions doctor --json --no-remote >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" update --check --json --no-remote >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" publish-check --json --no-remote >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" themes current --json >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" external list --json >/dev/null
  node "$PI67_CLI_BIN" --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" backups list --json >/dev/null
  node "$PI67_CLI_BIN" --dry-run self-update >/dev/null
  pass "pi-67 npm CLI smoke commands passed"

  if node - "$REPO_ROOT" "$PI67_CLI_BIN" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const [repoRoot, cli] = process.argv.slice(2);
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-xtalpi-config-"));
try {
  const result = spawnSync(process.execPath, [
    cli,
    "--agent-dir", agentDir,
    "--repo-root", repoRoot,
    "xtalpi", "configure", "--dry-run", "--no-prompt", "--json",
  ], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr || result.error?.message || `configure exited ${result.status}`);
  }
  const payload = JSON.parse(result.stdout);
  if (payload.schema !== "pi67-xtalpi-config/v1") throw new Error("unexpected configure schema");
  if (payload.provider !== "xtalpi-pi-tools" || payload.model !== "deepseek-v4-pro") {
    throw new Error("unexpected configure provider/model");
  }
  if (payload.configured !== false || payload.changed !== false || payload.skipped !== true || payload.dryRun !== true) {
    throw new Error("fresh configure dry-run must be a skipped no-op");
  }
  for (const file of ["models.json", "settings.json", "auth.json"]) {
    if (fs.existsSync(path.join(agentDir, file))) {
      throw new Error(`missing-key xtalpi dry-run created ${file}`);
    }
  }

  const genericConfigure = spawnSync(process.execPath, [
    cli,
    "--agent-dir", agentDir,
    "--repo-root", repoRoot,
    "configure", "--provider", "deepseek", "--no-prompt", "--json",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (genericConfigure.status !== 2 || !genericConfigure.stderr.includes("unknown command: configure")) {
    throw new Error("generic pi-67 configure must remain unavailable");
  }
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
}
NODE
  then
    pass "optional xtalpi configure and upstream provider ownership contracts passed"
  else
    fail "optional xtalpi configure or upstream provider ownership contract failed"
  fi
else
  warn "node not found; skipped pi-67 npm CLI checks"
fi

if command_exists npm; then
  npm pack --dry-run "$PI67_CLI_DIR" >/dev/null 2>&1
  pass "pi-67 npm CLI package packs cleanly"
else
  warn "npm not found; skipped pi-67 npm CLI pack dry-run"
fi

if [ -f "$NPM_PUBLISH_WORKFLOW" ]; then
  if grep -q "workflow_dispatch" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "id-token: write" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "Use npm with trusted publishing support" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q 'npm_version="$(npm --version)"' "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "require >= 11.5.1" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "Validate npm publish target" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "Verify published npm version and requested dist-tag" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q 'npm view "${package_name}@${NPM_TAG}" version' "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "first_publish_confirm" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "publish-check --strict --no-pack" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q -- "--allow-first-publish" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "npm publish ./packages/pi67-cli --access public --tag" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "auth_mode" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "token-bootstrap" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "inputs.auth_mode == 'token-bootstrap' && secrets.NPM_TOKEN" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "auth_mode=token-bootstrap requires repository secret NPM_TOKEN" "$NPM_PUBLISH_WORKFLOW" \
    && grep -q "No long-lived token is configured here" "$NPM_PUBLISH_WORKFLOW"; then
    pass "pi-67 npm publish workflow uses trusted publishing"
  else
    fail "pi-67 npm publish workflow is missing trusted publishing safeguards"
  fi
else
  fail "pi-67 npm publish workflow is missing trusted publishing safeguards"
fi

if [ -f "$CHANGELOG" ]; then
  pass "CHANGELOG.md exists"
  if [ -n "$VERSION" ] && grep -q "^## \\[$VERSION\\]" "$CHANGELOG"; then
    pass "CHANGELOG has entry for $VERSION"
  else
    fail "CHANGELOG missing entry for $VERSION"
  fi
else
  fail "missing CHANGELOG.md"
fi

if [ -n "$VERSION" ] && grep -q "当前发行版版本：\`$VERSION\`" "$REPO_ROOT/README.md"; then
  pass "README current release version matches VERSION"
else
  fail "README current release version does not match VERSION ($VERSION)"
fi

if [ -f "$RELEASE_DOC" ]; then
  pass "docs/release.md exists"
else
  fail "missing docs/release.md"
fi

if grep -q "pi67-release-check.sh" "$REPO_ROOT/README.md" && grep -q "pi67-release-check.sh" "$RELEASE_DOC"; then
  pass "release check is documented"
else
  fail "release check is not documented in README.md and docs/release.md"
fi

if grep -q "npm install -g @bigking67/pi-67" "$REPO_ROOT/README.md" && grep -q "pi-67 update" "$REPO_ROOT/README.md" && grep -q "pi-67 publish-check" "$REPO_ROOT/README.md" && grep -q "pi-67 manifest" "$REPO_ROOT/README.md" && grep -q "pi-67 manifest --validate" "$REPO_ROOT/README.md" && grep -q "pi-67 extensions doctor" "$REPO_ROOT/README.md" && grep -q "pi-67 backups list" "$REPO_ROOT/README.md" && grep -q "pi update --extensions" "$REPO_ROOT/README.md" && grep -Eq "settings\\.json.*theme|settings\\.json\\.theme" "$REPO_ROOT/README.md" && grep -q "Trusted Publishing" "$RELEASE_DOC" && grep -q "pi-67 publish-check" "$RELEASE_DOC" && grep -q "pi-67 manifest --json" "$RELEASE_DOC" && grep -q "pi-67 manifest --validate" "$RELEASE_DOC" && grep -q "pi-67 extensions doctor" "$RELEASE_DOC" && grep -q "pi-67 backups list" "$RELEASE_DOC" && grep -q "npm publish .*--access public" "$RELEASE_DOC"; then
  pass "pi-67 npm CLI install/update/theme/publish docs are present"
else
  fail "pi-67 npm CLI install/update/theme/publish docs are missing"
fi

if [ -f "$POWERSHELL_SMOKE" ] && [ -f "$POWERSHELL_BOOTSTRAP" ] && [ -f "$POWERSHELL_UPDATE" ] && [ -f "$POWERSHELL_ACCEPTANCE" ] && [ -f "$POWERSHELL_DOCTOR" ] && [ -f "$POWERSHELL_REPORT" ] && [ -f "$JSON_UTIL_PS" ] && [ -f "$JSON_UTIL_CJS" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_PS" ] && [ -f "$WINDOWS_FRESH_INSTALL_DOC" ] && [ -f "$XTALPI_CONFIG_LIB" ] && [ -f "$PROVIDER_STATUS_SCRIPT" ] && [ -f "$PI67_XTALPI_COMMAND" ] && grep -q "pi67-bootstrap.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-bootstrap.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-bootstrap.ps1" "$RELEASE_DOC" && grep -q "pi67-bootstrap.ps1" "$TROUBLESHOOTING_DOC" && grep -q "pi67-bootstrap.ps1" "$WINDOWS_FRESH_INSTALL_DOC" && grep -q "pi67-smoke.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-smoke.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-smoke.ps1" "$RELEASE_DOC" && grep -q "pi67-update.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-update.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-update.ps1" "$RELEASE_DOC" && grep -q "pi67-windows-acceptance.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-windows-acceptance.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-windows-acceptance.ps1" "$RELEASE_DOC" && grep -q "pi67-windows-acceptance.ps1" "$TROUBLESHOOTING_DOC" && grep -q "pi67-doctor.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-doctor.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-doctor.ps1" "$RELEASE_DOC" && grep -q "pi67-report.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-report.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-report.ps1" "$RELEASE_DOC" && grep -q "pi67-xtalpi-pi-tools-smoke.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-pi-tools-smoke.ps1" "$FULL_INSTALL_DOC" && grep -q "pi67-xtalpi-pi-tools-smoke.ps1" "$RELEASE_DOC" && grep -q "PowerShell" "$XTALPI_PI_TOOLS_DOC"; then
  pass "Windows PowerShell update/acceptance/doctor/report/smoke entrypoints are documented"
else
  fail "Windows PowerShell update/acceptance/doctor/report/smoke entrypoints are missing or not documented"
fi

if grep -q '\[switch\]\$SelfTest' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Node.js 24 LTS' "$POWERSHELL_BOOTSTRAP" \
  && grep -q '22.19.0' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Repair-WinGetPackageManager -AllUsers' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Microsoft.WindowsTerminal' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Microsoft.PowerShell' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'zufuliu.notepad4' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Git.Git' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Schniz.fnm' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'lts/krypton' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'fnm env --use-on-cd --shell powershell' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'defaultProfile' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Notepad4SystemIntegration' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'Start-Process.*-Verb RunAs' "$POWERSHELL_BOOTSTRAP" \
  && grep -q '\[switch\]\$NoXtalpiPrompt' "$POWERSHELL_BOOTSTRAP" \
  && grep -Fq '"xtalpi", "configure", "--verify"' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'pi67.windows-bootstrap.v4' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'selectionManagedByPi67 = \$false' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'persistenceOwner = "upstream-pi"' "$POWERSHELL_BOOTSTRAP" \
  && grep -q 'RESULT: PASS' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -q 'READY_WITHOUT_PROVIDER' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -q 'READY_WITHOUT_XTALPI' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -q '"configure", "--provider"' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -q 'OpenJS.NodeJS.LTS' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -Fq 'pi-67 launch' "$POWERSHELL_BOOTSTRAP" \
  && ! grep -q -- '-SkipUpdate' "$POWERSHELL_BOOTSTRAP"; then
  pass "Windows fresh-machine bootstrap contract is complete"
else
  fail "Windows fresh-machine bootstrap contract is incomplete"
fi

if grep -q 'Node.js 24 LTS' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q '22.19.0' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'Repair-WinGetPackageManager -AllUsers' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'Windows Terminal' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'PowerShell 7' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'zufuliu.notepad4' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'Schniz.fnm' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'lts/krypton' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -Fq 'pi-67 xtalpi configure --verify' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q '/login' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q '/model' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'RESULT: PASS' "$WINDOWS_FRESH_INSTALL_DOC" \
  && ! grep -q 'pi-67 configure --verify' "$WINDOWS_FRESH_INSTALL_DOC" \
  && ! grep -q 'pi-67 configure --provider' "$WINDOWS_FRESH_INSTALL_DOC" \
  && ! grep -q 'READY_WITHOUT_PROVIDER' "$WINDOWS_FRESH_INSTALL_DOC" \
  && ! grep -q 'READY_WITHOUT_XTALPI' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'Invoke-WebRequest' "$WINDOWS_FRESH_INSTALL_DOC" \
  && grep -q 'UseBasicParsing' "$WINDOWS_FRESH_INSTALL_DOC" \
  && ! grep -Fq 'irm | iex' "$WINDOWS_FRESH_INSTALL_DOC"; then
  pass "Windows fresh-install documentation preserves the runtime and security contract"
else
  fail "Windows fresh-install documentation contract is incomplete"
fi

if grep -q '\[switch\]\$SkipUpdate' "$POWERSHELL_ACCEPTANCE" \
  && grep -q '\[switch\]\$SelfTest' "$POWERSHELL_ACCEPTANCE" \
  && grep -q '\[switch\]\$ValidateWorkstation' "$POWERSHELL_ACCEPTANCE" \
  && grep -q '\[string\]\$ProviderProfile = "auto"' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'Assert-WorkstationContract' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'fnm env --use-on-cd --shell powershell' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'Arguments = @("self-update")' "$POWERSHELL_ACCEPTANCE" \
  && grep -q '"update", "--repair", "--yes"' "$POWERSHELL_ACCEPTANCE" \
  && grep -Fq 'Invoke-CommandStage "pi-runtime" "pi" @("--version")' "$POWERSHELL_ACCEPTANCE" \
  && grep -Fq 'Invoke-CommandStage "pi-extension-load" "pi"' "$POWERSHELL_ACCEPTANCE" \
  && ! grep -Fq 'Invoke-CommandStage "launch"' "$POWERSHELL_ACCEPTANCE" \
  && grep -q '"read-package", "read-enoent-recovery"' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'read,fffind,read' "$POWERSHELL_ACCEPTANCE" \
  && grep -Fq 'Invoke-CommandStage "daily-pi-live" "pi"' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'piStartupReady' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'modelRequestReady' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'pi67-provider-status.mjs' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'upstream-pi-default-request' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'pi67.windows-acceptance.v4' "$POWERSHELL_ACCEPTANCE" \
  && ! grep -q 'READY_WITHOUT_PROVIDER' "$POWERSHELL_ACCEPTANCE" \
  && ! grep -q 'READY_WITHOUT_XTALPI' "$POWERSHELL_ACCEPTANCE" \
  && grep -q 'RESULT: PASS' "$POWERSHELL_ACCEPTANCE"; then
  pass "Windows one-command acceptance validates the real Pi runtime"
else
  fail "Windows one-command acceptance contract is incomplete"
fi

if grep -q '\[string\[\]\]\$Profile' "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "extension-low-risk" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "extension-expanded" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "read-package" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "read-enoent-recovery" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "plan-mode-contract" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "plan-mode-accepted-continuation" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "until-done-continuation" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "fffind-package" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "batch-web-fetch-example" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "seq-thinking-status" "$XTALPI_PI_TOOLS_SMOKE_PS" && grep -q "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found" "$REPO_ROOT/README.md" && grep -q "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk" "$XTALPI_PI_TOOLS_DOC"; then
  pass "PowerShell xtalpi targeted smoke covers expanded low-risk extension cases"
else
  fail "PowerShell xtalpi targeted smoke expanded cases are missing or not documented"
fi

if grep -q "pi67-update.sh" "$REPO_ROOT/README.md" \
  && grep -q "pi67-update.sh" "$REPO_ROOT/docs/full-install.md" \
  && grep -q "pi67-update.ps1" "$REPO_ROOT/README.md" \
  && grep -q "pi67-update.ps1" "$REPO_ROOT/docs/full-install.md" \
  && ! grep -q 'Invoke-ProviderSelectionMigration' "$POWERSHELL_UPDATE" \
  && ! grep -q '"configure", "--provider", "auto"' "$POWERSHELL_UPDATE"; then
  pass "update workflow is documented and preserves upstream provider/model ownership"
else
  fail "update workflow documentation or upstream provider ownership contract is incomplete"
fi

if [ -f "$PI67_CLI_SOURCE" ] \
  && [ -f "$PI67_XTALPI_COMMAND" ] \
  && ! grep -q '^  configure:' "$PI67_CLI_SOURCE" \
  && grep -q 'if (sub === "configure")' "$PI67_XTALPI_COMMAND" \
  && grep -q 'use /login and /model inside Pi' "$PI67_XTALPI_COMMAND" \
  && ! grep -q 'pi-67 configure --provider' "$REPO_ROOT/README.md" \
  && ! grep -q 'pi-67 configure --provider' "$FULL_INSTALL_DOC" \
  && ! grep -q 'pi-67 configure --provider' "$TROUBLESHOOTING_DOC" \
  && ! grep -q 'pi-67 configure --provider' "$WINDOWS_FRESH_INSTALL_DOC"; then
  pass "pi-67 keeps only the optional xtalpi configure helper and leaves provider selection to upstream Pi"
else
  fail "generic pi-67 provider selection or stale documentation is still present"
fi

if grep -q "UTF-8 without BOM" "$REPO_ROOT/README.md" && grep -q "UTF-8 without BOM" "$FULL_INSTALL_DOC" && grep -q "models.json.bak-" "$TROUBLESHOOTING_DOC" && grep -q "UTF-8 without BOM" "$XTALPI_PI_TOOLS_DOC"; then
  pass "Windows JSON encoding normalization is documented"
else
  fail "Windows JSON encoding normalization is not documented"
fi

if grep -q "pi67-report.json" "$REPO_ROOT/README.md" && grep -q "pi67-report.json" "$REPO_ROOT/docs/full-install.md"; then
  pass "install/update report is documented"
else
  fail "install/update report is not documented in README.md and docs/full-install.md"
fi

if [ -f "$REPORT_SCHEMA_DOC" ] && grep -q "pi67-report/v2" "$REPORT_SCHEMA_DOC"; then
  pass "report schema v2 is documented"
else
  fail "report schema v2 is not documented"
fi

if [ -f "$DOCTOR_SCHEMA_DOC" ] && grep -q "pi67-doctor/v2" "$DOCTOR_SCHEMA_DOC"; then
  pass "doctor schema v2 is documented"
else
  fail "doctor schema v2 is not documented"
fi

if [ -f "$STATUS_DOC" ] && grep -q "pi67-status.sh" "$STATUS_DOC" && grep -q "pi67-status.sh" "$REPO_ROOT/README.md" && grep -q "pi67-status.sh" "$REPO_ROOT/docs/full-install.md"; then
  pass "status workflow is documented"
else
  fail "status workflow is not documented"
fi

if [ -f "$SKILL_MIGRATION_SCHEMA_DOC" ] && grep -q "pi67-skill-migration/v1" "$SKILL_MIGRATION_SCHEMA_DOC"; then
  pass "skill migration schema v1 is documented"
else
  fail "skill migration schema v1 is not documented"
fi

if [ -f "$EXTERNAL_SKILL_SYNC_SCHEMA_DOC" ] && grep -q "pi67-external-skill-sync/v1" "$EXTERNAL_SKILL_SYNC_SCHEMA_DOC"; then
  pass "external skill sync schema v1 is documented"
else
  fail "external skill sync schema v1 is not documented"
fi

if [ -f "$SKILL_GOV_DOC" ] && grep -q "pi67-migrate-skills.sh" "$SKILL_GOV_DOC" && grep -q "pi67-sync-external-skills.sh" "$SKILL_GOV_DOC" && grep -q "pi67-migrate-skills.sh" "$FULL_INSTALL_DOC" && grep -q "pi67-sync-external-skills.sh" "$FULL_INSTALL_DOC" && grep -q "pi67-migrate-skills.sh" "$TROUBLESHOOTING_DOC"; then
  pass "skill migration/sync workflows are documented"
else
  fail "skill migration/sync workflows are not documented"
fi

if [ -f "$SKILL_GOVERNANCE_TEST" ] && [ -f "$EXTERNAL_SKILLS_CHECK" ] && [ -f "$COMMERCE_GROWTH_SYNC" ] && [ -f "$RELEASE_ARTIFACT_SMOKE" ]; then
  pass "governance and artifact check scripts exist"
else
  fail "governance and artifact check scripts are missing"
fi

if grep -q "pi67-test-skill-governance.sh" "$SKILL_GOV_DOC" && grep -q "pi67-check-external-skills.sh" "$SKILL_GOV_DOC" && grep -q "pi67-sync-commerce-growth-os.sh" "$SKILL_GOV_DOC"; then
  pass "skill governance check scripts are documented"
else
  fail "skill governance check scripts are not documented"
fi

if grep -q "pi67-release-artifact-smoke.sh" "$RELEASE_DOC"; then
  pass "release artifact smoke is documented"
else
  fail "release artifact smoke is not documented"
fi

if [ -f "$XTALPI_PI_TOOLS_SCRIPT" ] && [ -f "$XTALPI_PI_TOOLS_SCRIPT_PS" ] && [ -f "$XTALPI_PI_TOOLS_TEST" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_PS" ] && [ -f "$XTALPI_PI_TOOLS_DEBUG_SUMMARY" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_STATUS_CORE" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_PLAN" ] && [ -f "$XTALPI_PI_TOOLS_PROVIDER_HEALTH" ] && [ -f "$XTALPI_PI_TOOLS_CAPABILITY_PROBE" ] && [ -f "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" ] && [ -f "$XTALPI_PI_TOOLS_COVERAGE_AUDIT" ] && [ -f "$XTALPI_PI_TOOLS_REPLAY_FIXTURES" ] && [ -f "$XTALPI_PI_TOOLS_ERROR_CONTRACT" ] && [ -f "$XTALPI_PI_TOOLS_JSON_FILE" ] && [ -f "$XTALPI_PI_TOOLS_JSON_ACTION_PROTOCOL" ] && [ -f "$XTALPI_PI_TOOLS_DOC" ] && [ -f "$UNTIL_DONE_QUEUE_PATCH_MJS" ] && [ -f "$UNTIL_DONE_QUEUE_PATCH_SH" ] && [ -f "$UNTIL_DONE_QUEUE_PATCH_PS" ]; then
  pass "xtalpi-pi-tools and pi-until-done compatibility helpers exist"
else
  fail "xtalpi-pi-tools or pi-until-done compatibility helpers are missing"
fi

if grep -q "pi67-xtalpi-provider-capability-probe.mjs" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-provider-capability-probe.mjs" "$XTALPI_PI_TOOLS_DOC" && grep -q "provider-capabilities.v1" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools provider capability probe is documented"
else
  fail "xtalpi-pi-tools provider capability probe is not documented"
fi

if [ -f "$XTALPI_PI_TOOLS_COVERAGE_AUDIT" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_PLAN" ] && grep -q "pi67-xtalpi-tool-coverage-audit.sh" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-xtalpi-smoke-plan.mjs" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools extension coverage audit is documented"
else
  fail "xtalpi-pi-tools extension coverage audit or smoke plan is not documented"
fi

if command_exists node; then
  node --check "$JSON_UTIL_CJS" >/dev/null
  node "$JSON_UTIL_CJS" --self-test >/dev/null
  node --check "$MCP_CONFIG_UTIL_CJS" >/dev/null
  node --check "$UNTIL_DONE_QUEUE_PATCH_MJS" >/dev/null
  node "$UNTIL_DONE_QUEUE_PATCH_MJS" --self-test >/dev/null
  pass "JSON compatibility and MCP config utilities passed syntax/self-tests"
else
  warn "node not found; skipped JSON compatibility and pi-until-done queue utility self-tests"
fi

if command_exists node; then
  COVERAGE_AUDIT_JSON="$(mktemp "${TMPDIR:-/tmp}/pi67-xtalpi-tool-coverage.XXXXXX.json")"
  COVERAGE_AUDIT_HAS_DEPS=0
  if [ -d "$REPO_ROOT/npm/node_modules" ] || [ -d "$REPO_ROOT/git/github.com" ]; then
    COVERAGE_AUDIT_HAS_DEPS=1
  fi
  if bash "$XTALPI_PI_TOOLS_COVERAGE_AUDIT" --agent-dir "$REPO_ROOT" --include pi-rules-loader --include pi-vision-bridge --json > "$COVERAGE_AUDIT_JSON" && node - "$COVERAGE_AUDIT_JSON" "$COVERAGE_AUDIT_HAS_DEPS" <<'NODE'
const fs = require("fs");
const path = require("path");
const [file, hasDepsRaw] = process.argv.slice(2);
const hasDeps = hasDepsRaw === "1";
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(data.schemaId === "pi67-xtalpi-tool-coverage-audit/v1", `unexpected schemaId: ${data.schemaId}`);
assert(data.summary?.total >= 19, "coverage audit did not include all expected settings/local targets");
const rulesLoader = data.entries.find((entry) => entry.spec === "local:extensions/pi-rules-loader");
assert(rulesLoader?.installed === true, "coverage audit did not include installed pi-rules-loader");
assert(rulesLoader.surface === "command_or_hook_only", `unexpected pi-rules-loader surface: ${rulesLoader?.surface}`);
const visionBridge = data.entries.find((entry) => entry.spec === "local:extensions/pi-vision-bridge");
assert(visionBridge?.installed === true, "coverage audit did not include installed pi-vision-bridge");
assert(visionBridge.modelCallableTools?.includes("vision_read"), "pi-vision-bridge did not expose vision_read evidence");
const mcp = data.entries.find((entry) => entry.spec === "npm:pi-mcp-adapter");
assert(mcp?.dynamicTools === true, "pi-mcp-adapter must remain marked as dynamic tool provider");
const installedMissingEvidence = data.entries.filter(
  (entry) => entry.installed && Object.values(entry.missingExpected || {}).some((items) => items.length > 0),
);
assert(installedMissingEvidence.length === 0, `coverage audit has missing evidence for installed targets: ${installedMissingEvidence.map((entry) => entry.spec).join(", ")}`);
if (hasDeps) {
  const missingSpecs = data.entries.filter((entry) => !entry.installed).map((entry) => entry.spec);
  const nonGitMissing = missingSpecs.filter((spec) => !spec.startsWith("git:github.com/"));
  assert(nonGitMissing.length === 0, `coverage audit found missing non-git installed targets: ${nonGitMissing.join(", ")}`);
  if (mcp.installed) assert(mcp.modelCallableTools.includes("mcp"), "pi-mcp-adapter gateway tool evidence missing");
}
NODE
  then
    if [ "$COVERAGE_AUDIT_HAS_DEPS" -eq 1 ]; then
      pass "xtalpi-pi-tools extension coverage audit passed for settings packages and local extensions"
    else
      pass "xtalpi-pi-tools extension coverage audit schema passed for dependency-free artifact"
    fi
  else
    fail "xtalpi-pi-tools extension coverage audit has missing or stale evidence"
  fi
  rm -f "$COVERAGE_AUDIT_JSON"
else
  warn "node not found; skipped xtalpi-pi-tools extension coverage audit validation"
fi

if command_exists node; then
  SMOKE_PLAN_JSON="$(mktemp "${TMPDIR:-/tmp}/pi67-xtalpi-smoke-plan.XXXXXX.json")"
  if node --check "$XTALPI_PI_TOOLS_SMOKE_PLAN" >/dev/null && node "$XTALPI_PI_TOOLS_SMOKE_PLAN" --repo-root "$REPO_ROOT" --agent-dir "$REPO_ROOT" --json > "$SMOKE_PLAN_JSON" && node - "$SMOKE_PLAN_JSON" <<'NODE'
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(data.schemaId === "pi67-xtalpi-smoke-plan/v1", `unexpected schemaId: ${data.schemaId}`);
assert(data.summary?.packages >= 19, "smoke plan did not include all settings/local targets");
assert(data.summary?.unknownPolicyPackages === 0, "smoke plan has unknown package policies");
assert(data.recommendedCommands?.windowsExpanded?.includes("extension-expanded"), "missing Windows expanded command");
const fff = data.packages.find((entry) => entry.spec === "npm:@ff-labs/pi-fff");
assert(fff, "FFF smoke plan missing package entry");
if (fff.installed) {
  assert(fff.recommendedWindowsCases?.includes("fffind-package"), "FFF smoke plan missing fffind-package");
} else {
  assert(fff.status === "missing_package", `unexpected FFF status for dependency-free artifact: ${fff.status}`);
}
const smartFetch = data.packages.find((entry) => entry.spec === "npm:pi-smart-fetch");
assert(smartFetch, "smart-fetch smoke plan missing package entry");
if (smartFetch.installed) {
  assert(smartFetch.windowsCoveredTools?.includes("batch_web_fetch"), "smart-fetch smoke plan missing batch_web_fetch coverage");
} else {
  assert(smartFetch.status === "missing_package", `unexpected smart-fetch status for dependency-free artifact: ${smartFetch.status}`);
}
const rulesLoader = data.packages.find((entry) => entry.spec === "local:extensions/pi-rules-loader");
assert(rulesLoader?.status === "not_model_callable", "rules-loader should be classified as not model-callable");
const visionBridge = data.packages.find((entry) => entry.spec === "local:extensions/pi-vision-bridge");
assert(visionBridge?.smokePolicy === "manual_artifact", "vision bridge should be classified as manual artifact smoke");
NODE
  then
    pass "xtalpi-pi-tools smoke plan validation passed"
  else
    fail "xtalpi-pi-tools smoke plan validation failed"
  fi
  rm -f "$SMOKE_PLAN_JSON"
else
  warn "node not found; skipped xtalpi-pi-tools smoke plan validation"
fi

if command_exists node; then
  node --check "$XTALPI_PI_TOOLS_SMOKE_STATUS_CORE" >/dev/null
  node --check "$XTALPI_PI_TOOLS_CAPABILITY_PROBE" >/dev/null
  node "$XTALPI_PI_TOOLS_CAPABILITY_PROBE" --self-test >/dev/null
  node "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" "$XTALPI_PI_TOOLS_ERROR_CONTRACT" --self-test >/dev/null
  node "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" "$XTALPI_PI_TOOLS_ERROR_CONTRACT" >/dev/null
  pass "xtalpi-pi-tools capability probe and provider error contract self-tests passed"
else
  warn "node not found; skipped capability probe and provider error contract validation"
fi

if bash "$XTALPI_PI_TOOLS_DEBUG_SUMMARY" --self-test >/dev/null; then
  pass "xtalpi-pi-tools debug-summary and strict trend profiles self-test passed"
else
  fail "xtalpi-pi-tools debug-summary or strict trend profiles self-test failed"
fi

if grep -q "pi-67 xtalpi run" "$REPO_ROOT/README.md" && grep -q "pi-67 xtalpi run" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi-67 xtalpi run" "$FULL_INSTALL_DOC" && grep -q "pi67-xtalpi-pi-tools.sh" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-pi-tools.sh" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-xtalpi-pi-tools.sh" "$TROUBLESHOOTING_DOC" && grep -q "pi67-xtalpi-pi-tools.sh" "$FULL_INSTALL_DOC" && grep -q "pi67-xtalpi-pi-tools.ps1" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-pi-tools.ps1" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-xtalpi-pi-tools.ps1" "$FULL_INSTALL_DOC"; then
  pass "xtalpi-pi-tools launcher is documented"
else
  fail "xtalpi-pi-tools launcher is not documented"
fi

if grep -q "PI_OBSERVATIONAL_MEMORY_PASSIVE" "$XTALPI_PI_TOOLS_SCRIPT" && grep -q "PI_OBSERVATIONAL_MEMORY_PASSIVE" "$XTALPI_PI_TOOLS_SCRIPT_PS" && grep -q "PI_OBSERVATIONAL_MEMORY_PASSIVE" "$XTALPI_PI_TOOLS_DOC" && grep -q "XTALPI_PI_TOOLS_SMOKE_OBSERVATIONAL_MEMORY_PASSIVE" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools launchers and smoke docs isolate observational memory"
else
  fail "xtalpi-pi-tools observational-memory lifecycle isolation is not documented or configured"
fi

if grep -q "skillListTimeoutSeconds" "$DOCTOR_SCHEMA_DOC" && grep -q -- "--skill-list-timeout-seconds" "$DOCTOR_SCHEMA_DOC" && grep -q "SkillListTimeoutSeconds" "$POWERSHELL_DOCTOR"; then
  pass "doctor skill-list timeout is documented and PowerShell-compatible"
else
  fail "doctor skill-list timeout documentation or PowerShell parity is missing"
fi

if ! grep -q '\$KnownPaths = @("settings.json", "extensions/xtalpi-compat/index.ts")' "$REPO_ROOT/README.md" "$TROUBLESHOOTING_DOC" "$FULL_INSTALL_DOC"; then
  pass "bootstrap docs no longer recommend legacy xtalpi-compat runtime path"
else
  fail "bootstrap docs still reference legacy xtalpi-compat runtime path"
fi

if grep -q "provider-error-contract.json" "$REPO_ROOT/README.md" && grep -q "provider-error-contract.json" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-validate-xtalpi-provider-error-contract.mjs" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools provider error contract is documented"
else
  fail "xtalpi-pi-tools provider error contract is not documented"
fi

if grep -q "dyn_echo_ping" "$XTALPI_PI_TOOLS_TEST" && grep -q "DYN_ECHO_PING_SENTINEL" "$XTALPI_PI_TOOLS_TEST" && grep -q "pi-mcp-adapter-src" "$XTALPI_PI_TOOLS_TEST" && grep -q "mcp-cache.json" "$XTALPI_PI_TOOLS_TEST" && grep -q "round-trip" "$REPO_ROOT/README.md" && grep -q "PI_CODING_AGENT_DIR" "$REPO_ROOT/README.md" && grep -q "DYN_ECHO_PING_SENTINEL" "$XTALPI_PI_TOOLS_DOC" && grep -q "mcp-cache.json" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools dynamic MCP direct-tool round-trip and adapter registration regressions are documented"
else
  fail "xtalpi-pi-tools dynamic MCP direct-tool round-trip or adapter registration regression is missing or not documented"
fi

if grep -q '"xtalpi-pi-tools"' "$REPO_ROOT/models.example.json" && ! grep -q '"xtalpi-tools"' "$REPO_ROOT/models.example.json"; then
  pass "xtalpi-pi-tools is the only xtalpi provider template; active selection remains upstream-owned"
else
  fail "xtalpi-pi-tools provider template is not clean"
fi

if command_exists node; then
  if node - \
    "$REPO_ROOT/models.example.json" \
    "$XTALPI_PI_TOOLS_RUNTIME_CONFIG" \
    "$XTALPI_PI_TOOLS_PROVIDER_HEALTH" \
    "$XTALPI_PI_TOOLS_CAPABILITY_PROBE" \
    "$XTALPI_PI_TOOLS_JSON_ACTION_PROTOCOL" \
    "$REPO_ROOT/extensions/xtalpi-pi-tools/chat-client.ts" \
    "$REPO_ROOT/extensions/xtalpi-pi-tools/provider-turn.ts" \
    "$REPO_ROOT/extensions/xtalpi-pi-tools/response-normalizer.ts" <<'NODE'
const fs = require("fs");
const path = require("path");
const [
  modelsFile,
  runtimeConfigFile,
  providerHealthFile,
  capabilityProbeFile,
  jsonActionProtocolFile,
  chatClientFile,
  providerTurnFile,
  responseNormalizerFile,
] = process.argv.slice(2);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
const repoRoot = path.dirname(modelsFile);
const provider = models.providers?.["xtalpi-pi-tools"];
assert(provider, "models.example.json missing xtalpi-pi-tools provider");
assert(provider.api === "xtalpi-pi-tools", "xtalpi-pi-tools provider must not use openai-responses or another adapter");
assert(
  provider.baseUrl === "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1",
  "xtalpi-pi-tools baseUrl must be the OpenAI v1 root, not a /responses or already-suffixed endpoint",
);
const runtimeConfig = fs.readFileSync(runtimeConfigFile, "utf8");
const providerHealth = fs.readFileSync(providerHealthFile, "utf8");
const capabilityProbe = fs.readFileSync(capabilityProbeFile, "utf8");
const jsonActionProtocol = fs.readFileSync(jsonActionProtocolFile, "utf8");
const chatClient = fs.readFileSync(chatClientFile, "utf8");
const providerTurn = fs.readFileSync(providerTurnFile, "utf8");
const responseNormalizer = fs.readFileSync(responseNormalizerFile, "utf8");
const repositorySources = [
  ["README.md", fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")],
  ["CHANGELOG.md", fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8")],
  ["docs/troubleshooting.md", fs.readFileSync(path.join(repoRoot, "docs", "troubleshooting.md"), "utf8")],
  ["docs/xtalpi-pi-tools.md", fs.readFileSync(path.join(repoRoot, "docs", "xtalpi-pi-tools.md"), "utf8")],
  ["runtime-config.ts", runtimeConfig],
  ["capability-probe.mjs", capabilityProbe],
  ["json-action-protocol.ts", jsonActionProtocol],
  ["chat-client.ts", chatClient],
  ["provider-turn.ts", providerTurn],
  ["response-normalizer.ts", responseNormalizer],
];
assert(runtimeConfig.includes("/chat/completions"), "runtime-config must append /chat/completions");
assert(providerHealth.includes("/chat/completions"), "provider-health must probe /chat/completions");
assert(capabilityProbe.includes("/chat/completions"), "capability probe must probe /chat/completions");
assert(!runtimeConfig.includes("/responses"), "runtime-config must not target OpenAI Responses API for xtalpi");
assert(!providerHealth.includes("/responses"), "provider-health must not probe OpenAI Responses API for xtalpi");
assert(!capabilityProbe.includes("/responses"), "capability probe must not probe OpenAI Responses API for xtalpi");
assert(jsonActionProtocol.includes("JSON_ACTION_PROTOCOL"), "JSON action protocol module must expose the fixed protocol constant");
assert(jsonActionProtocol.includes("jsonActionSystemPrompt"), "JSON action protocol module must expose the fixed system prompt");
assert(jsonActionProtocol.includes("jsonActionResponseFormat"), "JSON action protocol module must expose the fixed response format");
assert(
  chatClient.includes("JSON_ACTION_PROTOCOL") && !chatClient.includes("actionProtocol?:"),
  "chat response parsing must be hard-pinned to canonical JSON action protocol",
);
assert(
  !responseNormalizer.includes("actionProtocol"),
  "response normalization must not branch by action protocol",
);
assert(
  providerTurn.includes("parseJsonAction") && !providerTurn.includes(["parseToolCall", "ForProtocol"].join("")),
  "provider turn must parse JSON action directly without protocol selection",
);
const forbiddenFragments = [
  ["legacy", "_text"],
  ["XTALPI_PI_TOOLS_ACTION", "_PROTOCOL"],
  ["parseToolCall", "ForProtocol"],
  ["resolveAction", "Protocol"],
  ["createLocalAction", "Adapter"],
  ["LocalAction", "Adapter"],
  ["XtalpiAction", "Protocol"],
  ["responseFormat", "ForProtocol"],
  ["protocolSystem", "Prompt"],
  ["protocolVersion", "For"],
  ["wrapAssistantHistory", "ForProtocol"],
  ["shouldReplayRawAssistant", "ForRepair"],
  ["local_text", "_protocol"],
].map((parts) => parts.join(""));
for (const [label, source] of repositorySources) {
  for (const fragment of forbiddenFragments) {
    assert(!source.includes(fragment), `${label} retains old protocol selector residue`);
  }
}
NODE
  then
    pass "xtalpi-pi-tools endpoint and local action contracts are canonical"
  else
    fail "xtalpi-pi-tools endpoint or local action contract drifted"
  fi
else
  warn "node not found; skipped xtalpi-pi-tools endpoint contract validation"
fi

if grep -q "pi67-release.sh" "$REPO_ROOT/README.md" && grep -q "pi67-release.sh" "$REPO_ROOT/docs/release.md" && grep -q "npm-publish.yml" "$REPO_ROOT/docs/release.md"; then
  pass "release automation is documented"
else
  fail "release automation is not documented in README.md and docs/release.md"
fi

if grep -q 'pi67-bootstrap.ps1.sha256' "$RELEASE_SCRIPT" \
  && grep -q 'gh release create' "$RELEASE_SCRIPT" \
  && grep -q 'check_npm_manager_release_prerequisite' "$RELEASE_SCRIPT" \
  && grep -q 'npm view "\$exact_target" version' "$RELEASE_SCRIPT" \
  && grep -q 'npm view "\$latest_target" version' "$RELEASE_SCRIPT" \
  && grep -q 'check_release_head_contract' "$RELEASE_SCRIPT" \
  && grep -q 'HEAD:scripts/pi67-bootstrap.ps1' "$RELEASE_SCRIPT" \
  && grep -Eqi 'latest.*dist-tag' "$RELEASE_DOC" \
  && grep -q 'pi67-bootstrap.ps1.sha256' "$RELEASE_DOC"; then
  pass "GitHub Release uses committed bootstrap assets after exact/latest npm prerequisites"
else
  fail "GitHub Release committed-asset or npm exact/latest prerequisite contract is incomplete"
fi

if command_exists git && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$REPO_ROOT" diff --check >/dev/null; then
    pass "git diff --check passed"
  else
    fail "git diff --check failed"
  fi

  if git -C "$REPO_ROOT" ls-files --error-unmatch .gitattributes VERSION CHANGELOG.md .github/workflows/ci.yml .github/workflows/npm-publish.yml docs/release.md docs/windows-fresh-install.md docs/report-schema.md docs/doctor-schema.md docs/status.md docs/skill-migration-schema.md docs/external-skill-sync-schema.md docs/skill-governance.md docs/troubleshooting.md docs/xtalpi-pi-tools.md packages/pi67-cli/package.json packages/pi67-cli/README.md packages/pi67-cli/CHANGELOG.md packages/pi67-cli/bin/pi-67.mjs packages/pi67-cli/scripts/check.mjs packages/pi67-cli/src/cli.mjs packages/pi67-cli/src/commands/backups.mjs packages/pi67-cli/src/commands/extensions.mjs packages/pi67-cli/src/commands/manifest.mjs packages/pi67-cli/src/commands/publish-check.mjs packages/pi67-cli/src/commands/self-update.mjs packages/pi67-cli/src/commands/xtalpi.mjs packages/pi67-cli/src/data/distro-manifest.json packages/pi67-cli/src/data/extension-registry.json packages/pi67-cli/src/lib/distro-manifest.mjs packages/pi67-cli/src/lib/extension-registry.mjs packages/pi67-cli/src/lib/npm-registry.mjs packages/pi67-cli/src/lib/settings-runtime-clean.mjs packages/pi67-cli/src/lib/settings-runtime-state.mjs packages/pi67-cli/src/lib/update-safety.mjs packages/pi67-cli/src/lib/xtalpi-config.mjs packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs packages/pi67-cli/schemas/pi67-distro-manifest.schema.json packages/pi67-cli/schemas/pi67-extension-registry.schema.json packages/pi67-cli/schemas/pi67-publish-check.schema.json packages/pi67-cli/schemas/pi67-state.schema.json packages/pi67-cli/schemas/pi67-update-plan.schema.json scripts/pi67-bootstrap.ps1 scripts/pi67-check-external-skills.sh scripts/pi67-doctor.sh scripts/pi67-doctor.ps1 scripts/pi67-json-utils.cjs scripts/pi67-json-utils.ps1 scripts/pi67-mcp-config-utils.cjs scripts/pi67-migrate-skills.sh scripts/pi67-release-artifact-smoke.sh scripts/pi67-release-check.sh scripts/pi67-release.sh scripts/pi67-report.sh scripts/pi67-report.ps1 scripts/pi67-status.sh scripts/pi67-shared-skills-inventory.sh scripts/pi67-sync-commerce-growth-os.sh scripts/pi67-sync-external-skills.sh scripts/pi67-test-skill-governance.sh scripts/pi67-update.sh scripts/pi67-update.ps1 scripts/pi67-windows-acceptance.ps1 scripts/pi67-smoke.ps1 scripts/pi67-xtalpi-pi-tools.sh scripts/pi67-xtalpi-pi-tools.ps1 scripts/pi67-test-xtalpi-pi-tools.sh scripts/pi67-fuzz-xtalpi-parser.mjs scripts/pi67-patch-pi-until-done-runtime-queue.mjs scripts/pi67-patch-pi-until-done-runtime-queue.sh scripts/pi67-patch-pi-until-done-runtime-queue.ps1 scripts/pi67-xtalpi-pi-tools-smoke.sh scripts/pi67-xtalpi-pi-tools-smoke.ps1 scripts/pi67-xtalpi-pi-tools-debug-summary.sh scripts/pi67-xtalpi-tool-coverage-audit.sh scripts/pi67-xtalpi-smoke-status-core.cjs scripts/pi67-xtalpi-smoke-plan.mjs scripts/pi67-xtalpi-provider-health.mjs scripts/pi67-xtalpi-provider-capability-probe.mjs scripts/pi67-validate-xtalpi-provider-error-contract.mjs extensions/xtalpi-pi-tools/json-file.ts extensions/xtalpi-pi-tools/json-action-protocol.ts extensions/xtalpi-pi-tools/vision-bridge.ts extensions/xtalpi-pi-tools/browser-bridge.ts extensions/pi-vision-bridge/index.ts extensions/xtalpi-pi-tools/fixtures/replay-cases.json extensions/xtalpi-pi-tools/provider-error-contract.json >/dev/null 2>&1; then
    pass "release metadata files are tracked or staged"
  else
    warn "release metadata files are not all tracked yet; expected before final commit"
  fi
else
  warn "git not available; skipped git checks"
fi

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
  echo -e "${YELLOW}Result: PASS WITH WARNINGS${NC}"
else
  echo -e "${GREEN}Result: PASS${NC}"
fi
