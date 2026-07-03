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
RELEASE_DOC="$REPO_ROOT/docs/release.md"
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
RELEASE_ARTIFACT_SMOKE="$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh"
XTALPI_PI_TOOLS_SCRIPT="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools.sh"
XTALPI_PI_TOOLS_TEST="$REPO_ROOT/scripts/pi67-test-xtalpi-pi-tools.sh"
XTALPI_PI_TOOLS_SMOKE="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-smoke.sh"
XTALPI_PI_TOOLS_DEBUG_SUMMARY="$REPO_ROOT/scripts/pi67-xtalpi-pi-tools-debug-summary.sh"
XTALPI_PI_TOOLS_SMOKE_STATUS_CORE="$REPO_ROOT/scripts/pi67-xtalpi-smoke-status-core.cjs"
XTALPI_PI_TOOLS_PROVIDER_HEALTH="$REPO_ROOT/scripts/pi67-xtalpi-provider-health.mjs"
XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK="$REPO_ROOT/scripts/pi67-validate-xtalpi-provider-error-contract.mjs"
XTALPI_PI_TOOLS_REPLAY_FIXTURES="$REPO_ROOT/extensions/xtalpi-pi-tools/fixtures/replay-cases.json"
XTALPI_PI_TOOLS_ERROR_CONTRACT="$REPO_ROOT/extensions/xtalpi-pi-tools/provider-error-contract.json"

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

if grep -q "pi67-update.sh" "$REPO_ROOT/README.md" && grep -q "pi67-update.sh" "$REPO_ROOT/docs/full-install.md"; then
  pass "update workflow is documented"
else
  fail "update workflow is not documented in README.md and docs/full-install.md"
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

if [ -f "$SKILL_GOVERNANCE_TEST" ] && [ -f "$EXTERNAL_SKILLS_CHECK" ] && [ -f "$RELEASE_ARTIFACT_SMOKE" ]; then
  pass "governance and artifact check scripts exist"
else
  fail "governance and artifact check scripts are missing"
fi

if grep -q "pi67-test-skill-governance.sh" "$SKILL_GOV_DOC" && grep -q "pi67-check-external-skills.sh" "$SKILL_GOV_DOC"; then
  pass "skill governance check scripts are documented"
else
  fail "skill governance check scripts are not documented"
fi

if grep -q "pi67-release-artifact-smoke.sh" "$RELEASE_DOC"; then
  pass "release artifact smoke is documented"
else
  fail "release artifact smoke is not documented"
fi

if [ -f "$XTALPI_PI_TOOLS_SCRIPT" ] && [ -f "$XTALPI_PI_TOOLS_TEST" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE" ] && [ -f "$XTALPI_PI_TOOLS_DEBUG_SUMMARY" ] && [ -f "$XTALPI_PI_TOOLS_SMOKE_STATUS_CORE" ] && [ -f "$XTALPI_PI_TOOLS_PROVIDER_HEALTH" ] && [ -f "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" ] && [ -f "$XTALPI_PI_TOOLS_REPLAY_FIXTURES" ] && [ -f "$XTALPI_PI_TOOLS_ERROR_CONTRACT" ] && [ -f "$XTALPI_PI_TOOLS_DOC" ]; then
  pass "xtalpi-pi-tools launcher, tests, smoke, debug summary, smoke status core, provider health, error-contract check, fixtures, error contract, and docs exist"
else
  fail "xtalpi-pi-tools launcher, tests, smoke, debug summary, smoke status core, provider health, error-contract check, fixtures, error contract, or docs are missing"
fi

if command_exists node; then
  node --check "$XTALPI_PI_TOOLS_SMOKE_STATUS_CORE" >/dev/null
  node "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" "$XTALPI_PI_TOOLS_ERROR_CONTRACT" --self-test >/dev/null
  node "$XTALPI_PI_TOOLS_ERROR_CONTRACT_CHECK" "$XTALPI_PI_TOOLS_ERROR_CONTRACT" >/dev/null
  pass "xtalpi-pi-tools provider error contract validation and self-test passed"
else
  warn "node not found; skipped provider error contract validation"
fi

if bash "$XTALPI_PI_TOOLS_DEBUG_SUMMARY" --self-test >/dev/null; then
  pass "xtalpi-pi-tools debug-summary and strict trend profile self-test passed"
else
  fail "xtalpi-pi-tools debug-summary or strict trend profile self-test failed"
fi

if grep -q "pi67-xtalpi-pi-tools.sh" "$REPO_ROOT/README.md" && grep -q "pi67-xtalpi-pi-tools.sh" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-xtalpi-pi-tools.sh" "$TROUBLESHOOTING_DOC" && grep -q "pi67-xtalpi-pi-tools.sh" "$FULL_INSTALL_DOC"; then
  pass "xtalpi-pi-tools launcher is documented"
else
  fail "xtalpi-pi-tools launcher is not documented"
fi

if grep -q "provider-error-contract.json" "$REPO_ROOT/README.md" && grep -q "provider-error-contract.json" "$XTALPI_PI_TOOLS_DOC" && grep -q "pi67-validate-xtalpi-provider-error-contract.mjs" "$XTALPI_PI_TOOLS_DOC"; then
  pass "xtalpi-pi-tools provider error contract is documented"
else
  fail "xtalpi-pi-tools provider error contract is not documented"
fi

if grep -q '"defaultProvider": "xtalpi-pi-tools"' "$REPO_ROOT/settings.json" && grep -q '"xtalpi-pi-tools"' "$REPO_ROOT/models.example.json" && ! grep -q '"xtalpi-tools"' "$REPO_ROOT/models.example.json"; then
  pass "xtalpi-pi-tools is the only xtalpi provider template"
else
  fail "xtalpi-pi-tools provider template/default is not clean"
fi

if grep -q "pi67-release.sh" "$REPO_ROOT/README.md" && grep -q "pi67-release.sh" "$REPO_ROOT/docs/release.md"; then
  pass "release automation is documented"
else
  fail "release automation is not documented in README.md and docs/release.md"
fi

if command_exists git && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$REPO_ROOT" diff --check >/dev/null; then
    pass "git diff --check passed"
  else
    fail "git diff --check failed"
  fi

  if git -C "$REPO_ROOT" ls-files --error-unmatch VERSION CHANGELOG.md docs/release.md docs/report-schema.md docs/doctor-schema.md docs/status.md docs/skill-migration-schema.md docs/external-skill-sync-schema.md docs/skill-governance.md docs/troubleshooting.md docs/xtalpi-pi-tools.md scripts/pi67-check-external-skills.sh scripts/pi67-doctor.sh scripts/pi67-migrate-skills.sh scripts/pi67-release-artifact-smoke.sh scripts/pi67-release-check.sh scripts/pi67-release.sh scripts/pi67-report.sh scripts/pi67-status.sh scripts/pi67-sync-external-skills.sh scripts/pi67-test-skill-governance.sh scripts/pi67-update.sh scripts/pi67-xtalpi-pi-tools.sh scripts/pi67-test-xtalpi-pi-tools.sh scripts/pi67-xtalpi-pi-tools-smoke.sh scripts/pi67-xtalpi-pi-tools-debug-summary.sh scripts/pi67-xtalpi-smoke-status-core.cjs scripts/pi67-xtalpi-provider-health.mjs scripts/pi67-validate-xtalpi-provider-error-contract.mjs extensions/xtalpi-pi-tools/fixtures/replay-cases.json extensions/xtalpi-pi-tools/provider-error-contract.json >/dev/null 2>&1; then
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
