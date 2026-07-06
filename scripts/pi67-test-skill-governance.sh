#!/usr/bin/env bash
set -euo pipefail

# Dedicated fixture tests for pi-67 skill registry governance.
# This script only writes inside a temporary directory.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEEP_TMP=false
TMP_ROOT=""

usage() {
  cat <<'USAGE'
pi67-test-skill-governance validates skill migration/sync helper behavior.

Usage:
  scripts/pi67-test-skill-governance.sh [options]

Options:
      --repo-root DIR  Repository root. Defaults to this script's parent.
      --keep-tmp       Keep temporary fixture directory for inspection.
  -h, --help           Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
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

assert_json_result() {
  local file="$1"
  local schema_id="$2"
  local result="$3"
  node - "$file" "$schema_id" "$result" <<'NODE'
const fs = require("fs");
const [, , file, schemaId, result] = process.argv;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.schemaId !== schemaId) {
  throw new Error(`unexpected schemaId: ${data.schemaId}`);
}
if (result && data.result !== result) {
  throw new Error(`unexpected result: ${data.result}; expected ${result}`);
}
if (!data.counts || typeof data.counts !== "object") {
  throw new Error("missing counts");
}
NODE
}

assert_json_schema_result() {
  local file="$1"
  local schema_id="$2"
  local result="$3"
  node - "$file" "$schema_id" "$result" <<'NODE'
const fs = require("fs");
const [, , file, schemaId, result] = process.argv;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.schemaId !== schemaId) {
  throw new Error(`unexpected schemaId: ${data.schemaId}`);
}
if (result && data.result !== result) {
  throw new Error(`unexpected result: ${data.result}; expected ${result}`);
}
NODE
}

assert_json_count_at_least() {
  local file="$1"
  local count_path="$2"
  local min_value="$3"
  node - "$file" "$count_path" "$min_value" <<'NODE'
const fs = require("fs");
const [, , file, countPath, minValueRaw] = process.argv;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
let value = data;
for (const part of countPath.split(".")) {
  value = value?.[part];
}
const minValue = Number(minValueRaw);
if (typeof value !== "number" || value < minValue) {
  throw new Error(`${countPath} expected >= ${minValue}; got ${value}`);
}
NODE
}

assert_external_sync_layout() {
  local file="$1"
  local expected_name="$2"
  local expected_layout="$3"
  node - "$file" "$expected_name" "$expected_layout" <<'NODE'
const fs = require("fs");
const [, , file, expectedName, expectedLayout] = process.argv;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const repo = data.repositories?.[0];
if (!repo) {
  throw new Error("missing first repository entry");
}
if (!Array.isArray(repo.sourceLayouts) || !repo.sourceLayouts.includes(expectedLayout)) {
  throw new Error(`missing sourceLayouts entry ${expectedLayout}: ${JSON.stringify(repo.sourceLayouts)}`);
}
const skill = repo.skills?.find((entry) => entry.name === expectedName);
if (!skill) {
  throw new Error(`missing skill ${expectedName}`);
}
if (skill.sourceLayout !== expectedLayout) {
  throw new Error(`unexpected sourceLayout for ${expectedName}: ${skill.sourceLayout}`);
}
NODE
}

echo ""
echo -e "${CYAN}pi-67 skill governance tests${NC}"
echo "Repository: $REPO_ROOT"

[ -f "$REPO_ROOT/scripts/pi67-migrate-skills.sh" ] || fail "missing scripts/pi67-migrate-skills.sh"
[ -f "$REPO_ROOT/scripts/pi67-sync-external-skills.sh" ] || fail "missing scripts/pi67-sync-external-skills.sh"
[ -f "$REPO_ROOT/scripts/pi67-check-external-skills.sh" ] || fail "missing scripts/pi67-check-external-skills.sh"
[ -f "$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh" ] || fail "missing scripts/pi67-sync-commerce-growth-os.sh"
command_exists node || fail "node is required"
pass "required helpers found"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-skill-governance.XXXXXX")"

section "Migration helper dry-run"
MIGRATE_AGENT="$TMP_ROOT/migrate-agent"
MIGRATE_SHARED="$TMP_ROOT/migrate-shared"
MIGRATE_BACKUP="$TMP_ROOT/migrate-backup"
mkdir -p "$MIGRATE_AGENT/skills/legacy-skill"
cat > "$MIGRATE_AGENT/skills/legacy-skill/SKILL.md" <<'EOF'
# Legacy Skill

Skill governance dry-run fixture.
EOF

"$REPO_ROOT/scripts/pi67-migrate-skills.sh" \
  --agent-dir "$MIGRATE_AGENT" \
  --skills-dir "$MIGRATE_SHARED" \
  --backup-dir "$MIGRATE_BACKUP" \
  --dry-run \
  --json > "$TMP_ROOT/migrate-dry.json"
assert_json_result "$TMP_ROOT/migrate-dry.json" "pi67-skill-migration/v1" "READY_TO_APPLY"
assert_json_count_at_least "$TMP_ROOT/migrate-dry.json" "counts.missingCanonical" 1
if [ -e "$MIGRATE_SHARED/legacy-skill" ] || [ ! -d "$MIGRATE_AGENT/skills" ]; then
  fail "migration dry-run changed fixture roots"
fi
pass "migration dry-run is schema-valid and no-write"

section "Migration helper apply"
"$REPO_ROOT/scripts/pi67-migrate-skills.sh" \
  --agent-dir "$MIGRATE_AGENT" \
  --skills-dir "$MIGRATE_SHARED" \
  --backup-dir "$MIGRATE_BACKUP" \
  --apply \
  --yes \
  --json > "$TMP_ROOT/migrate-apply.json"
assert_json_result "$TMP_ROOT/migrate-apply.json" "pi67-skill-migration/v1" "APPLIED"
assert_json_count_at_least "$TMP_ROOT/migrate-apply.json" "counts.copied" 1
assert_json_count_at_least "$TMP_ROOT/migrate-apply.json" "counts.backedUpRoots" 1
if [ ! -f "$MIGRATE_SHARED/legacy-skill/SKILL.md" ] || [ -e "$MIGRATE_AGENT/skills" ] || [ ! -f "$MIGRATE_BACKUP/skills/legacy-skill/SKILL.md" ]; then
  fail "migration apply did not copy and back up the legacy root"
fi
pass "migration apply copies missing skills and backs up migrated roots"

section "Migration helper conflict"
MIGRATE_CONFLICT_AGENT="$TMP_ROOT/migrate-conflict-agent"
MIGRATE_CONFLICT_SHARED="$TMP_ROOT/migrate-conflict-shared"
mkdir -p "$MIGRATE_CONFLICT_AGENT/skills/conflict-skill" "$MIGRATE_CONFLICT_SHARED/conflict-skill"
printf '# Legacy Conflict\n' > "$MIGRATE_CONFLICT_AGENT/skills/conflict-skill/SKILL.md"
printf '# Canonical Conflict\n' > "$MIGRATE_CONFLICT_SHARED/conflict-skill/SKILL.md"
if "$REPO_ROOT/scripts/pi67-migrate-skills.sh" \
  --agent-dir "$MIGRATE_CONFLICT_AGENT" \
  --skills-dir "$MIGRATE_CONFLICT_SHARED" \
  --backup-dir "$TMP_ROOT/migrate-conflict-backup" \
  --apply \
  --yes \
  --json > "$TMP_ROOT/migrate-conflict.json" 2>&1; then
  fail "migration apply unexpectedly accepted a canonical conflict"
fi
assert_json_result "$TMP_ROOT/migrate-conflict.json" "pi67-skill-migration/v1" "NEEDS_REVIEW"
assert_json_count_at_least "$TMP_ROOT/migrate-conflict.json" "counts.conflicts" 1
if [ ! -d "$MIGRATE_CONFLICT_AGENT/skills" ] || ! grep -q 'Canonical Conflict' "$MIGRATE_CONFLICT_SHARED/conflict-skill/SKILL.md"; then
  fail "migration conflict path changed source or canonical roots"
fi
pass "migration refuses conflicts without overwriting either side"

section "External sync helper dry-run"
EXTERNAL_REPO="$TMP_ROOT/external-repo"
EXTERNAL_SHARED="$TMP_ROOT/external-shared"
mkdir -p "$EXTERNAL_REPO/skills/external-skill"
cat > "$EXTERNAL_REPO/skills/external-skill/SKILL.md" <<'EOF'
# External Skill

Skill governance external sync fixture.
EOF

"$REPO_ROOT/scripts/pi67-sync-external-skills.sh" \
  --repo "$EXTERNAL_REPO" \
  --skills-dir "$EXTERNAL_SHARED" \
  --dry-run \
  --json > "$TMP_ROOT/external-dry.json"
assert_json_result "$TMP_ROOT/external-dry.json" "pi67-external-skill-sync/v1" "READY_TO_APPLY"
assert_json_count_at_least "$TMP_ROOT/external-dry.json" "counts.missingCanonical" 1
if [ -e "$EXTERNAL_SHARED/external-skill" ]; then
  fail "external sync dry-run wrote files"
fi
pass "external sync dry-run is schema-valid and no-write"

section "External sync helper apply"
"$REPO_ROOT/scripts/pi67-sync-external-skills.sh" \
  --repo "$EXTERNAL_REPO" \
  --skills-dir "$EXTERNAL_SHARED" \
  --apply \
  --yes \
  --json > "$TMP_ROOT/external-apply.json"
assert_json_result "$TMP_ROOT/external-apply.json" "pi67-external-skill-sync/v1" "APPLIED"
assert_json_count_at_least "$TMP_ROOT/external-apply.json" "counts.copied" 1
if [ ! -f "$EXTERNAL_SHARED/external-skill/SKILL.md" ]; then
  fail "external sync apply did not copy the missing skill"
fi
pass "external sync apply copies missing skills"

section "External sync helper root-level dry-run"
EXTERNAL_ROOT_REPO="$TMP_ROOT/external-root-repo"
EXTERNAL_ROOT_SHARED="$TMP_ROOT/external-root-shared"
mkdir -p "$EXTERNAL_ROOT_REPO/.git" "$EXTERNAL_ROOT_REPO/node_modules/ignored" "$EXTERNAL_ROOT_REPO/eval/answers"
cat > "$EXTERNAL_ROOT_REPO/SKILL.md" <<'EOF'
---
name: root-skill
description: Root-level skill governance fixture.
---
# Root Skill

Root-level skill governance fixture.
EOF
printf 'ignored git metadata\n' > "$EXTERNAL_ROOT_REPO/.git/HEAD"
printf 'ignored gitignore\n' > "$EXTERNAL_ROOT_REPO/.gitignore"
printf 'ignored dependency\n' > "$EXTERNAL_ROOT_REPO/node_modules/ignored/package.json"
printf 'ignored eval answer\n' > "$EXTERNAL_ROOT_REPO/eval/answers/private.txt"
"$REPO_ROOT/scripts/pi67-sync-external-skills.sh" \
  --repo "$EXTERNAL_ROOT_REPO" \
  --skills-dir "$EXTERNAL_ROOT_SHARED" \
  --dry-run \
  --json > "$TMP_ROOT/external-root-dry.json"
assert_json_result "$TMP_ROOT/external-root-dry.json" "pi67-external-skill-sync/v1" "READY_TO_APPLY"
assert_external_sync_layout "$TMP_ROOT/external-root-dry.json" "root-skill" "repo-root"
if [ -e "$EXTERNAL_ROOT_SHARED/root-skill" ]; then
  fail "external root sync dry-run wrote files"
fi
pass "external sync discovers root-level SKILL.md without writing"

section "External sync helper root-level apply"
"$REPO_ROOT/scripts/pi67-sync-external-skills.sh" \
  --repo "$EXTERNAL_ROOT_REPO" \
  --skills-dir "$EXTERNAL_ROOT_SHARED" \
  --apply \
  --yes \
  --json > "$TMP_ROOT/external-root-apply.json"
assert_json_result "$TMP_ROOT/external-root-apply.json" "pi67-external-skill-sync/v1" "APPLIED"
assert_json_count_at_least "$TMP_ROOT/external-root-apply.json" "counts.copied" 1
assert_external_sync_layout "$TMP_ROOT/external-root-apply.json" "root-skill" "repo-root"
if [ ! -f "$EXTERNAL_ROOT_SHARED/root-skill/SKILL.md" ]; then
  fail "external root sync apply did not copy root-level skill"
fi
if [ -e "$EXTERNAL_ROOT_SHARED/root-skill/.git" ] || [ -e "$EXTERNAL_ROOT_SHARED/root-skill/.gitignore" ] || [ -e "$EXTERNAL_ROOT_SHARED/root-skill/node_modules" ] || [ -e "$EXTERNAL_ROOT_SHARED/root-skill/eval/answers" ]; then
  fail "external root sync copied ignored repository/cache/eval-answer paths"
fi
pass "external sync copies root-level skills and filters repository/cache artifacts"

section "Commerce growth vendored sync helper"
COMMERCE_SOURCE="$TMP_ROOT/commerce-source"
COMMERCE_DEST="$TMP_ROOT/commerce-dest/commerce-growth-os"
mkdir -p "$COMMERCE_SOURCE/.git" "$COMMERCE_SOURCE/node_modules/ignored" "$COMMERCE_SOURCE/eval/answers" "$COMMERCE_SOURCE/references"
cat > "$COMMERCE_SOURCE/SKILL.md" <<'EOF'
---
name: commerce-growth-os
description: Commerce growth fixture.
---
# Commerce Growth OS
EOF
printf 'reference\n' > "$COMMERCE_SOURCE/references/business-model-and-profit.md"
printf 'ignored git metadata\n' > "$COMMERCE_SOURCE/.git/HEAD"
printf 'ignored dependency\n' > "$COMMERCE_SOURCE/node_modules/ignored/package.json"
printf 'ignored private eval answer\n' > "$COMMERCE_SOURCE/eval/answers/private.txt"
"$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh" \
  --source "$COMMERCE_SOURCE" \
  --dest "$COMMERCE_DEST" \
  --dry-run \
  --json > "$TMP_ROOT/commerce-sync-dry.json"
assert_json_schema_result "$TMP_ROOT/commerce-sync-dry.json" "pi67-commerce-growth-os-sync/v1" "READY_TO_APPLY"
if [ -e "$COMMERCE_DEST" ]; then
  fail "commerce sync dry-run wrote files"
fi
"$REPO_ROOT/scripts/pi67-sync-commerce-growth-os.sh" \
  --source "$COMMERCE_SOURCE" \
  --dest "$COMMERCE_DEST" \
  --apply \
  --yes \
  --no-validate \
  --json > "$TMP_ROOT/commerce-sync-apply.json"
assert_json_schema_result "$TMP_ROOT/commerce-sync-apply.json" "pi67-commerce-growth-os-sync/v1" "APPLIED"
if [ ! -f "$COMMERCE_DEST/SKILL.md" ] || [ ! -f "$COMMERCE_DEST/references/business-model-and-profit.md" ]; then
  fail "commerce sync apply did not copy expected skill files"
fi
if [ -e "$COMMERCE_DEST/.git" ] || [ -e "$COMMERCE_DEST/node_modules" ] || [ -e "$COMMERCE_DEST/eval/answers" ]; then
  fail "commerce sync copied ignored repository/cache/eval-answer paths"
fi
pass "commerce growth vendored sync helper dry-runs, applies, and filters artifacts"

section "External sync helper conflict"
EXTERNAL_CONFLICT_REPO="$TMP_ROOT/external-conflict-repo"
EXTERNAL_CONFLICT_SHARED="$TMP_ROOT/external-conflict-shared"
mkdir -p "$EXTERNAL_CONFLICT_REPO/skills/conflict-skill" "$EXTERNAL_CONFLICT_SHARED/conflict-skill"
printf '# External Conflict\n' > "$EXTERNAL_CONFLICT_REPO/skills/conflict-skill/SKILL.md"
printf '# Canonical External Conflict\n' > "$EXTERNAL_CONFLICT_SHARED/conflict-skill/SKILL.md"
if "$REPO_ROOT/scripts/pi67-sync-external-skills.sh" \
  --repo "$EXTERNAL_CONFLICT_REPO" \
  --skills-dir "$EXTERNAL_CONFLICT_SHARED" \
  --apply \
  --yes \
  --json > "$TMP_ROOT/external-conflict.json" 2>&1; then
  fail "external sync unexpectedly accepted a canonical conflict"
fi
assert_json_result "$TMP_ROOT/external-conflict.json" "pi67-external-skill-sync/v1" "NEEDS_REVIEW"
assert_json_count_at_least "$TMP_ROOT/external-conflict.json" "counts.conflicts" 1
if ! grep -q 'Canonical External Conflict' "$EXTERNAL_CONFLICT_SHARED/conflict-skill/SKILL.md"; then
  fail "external sync conflict path changed canonical skill"
fi
pass "external sync refuses conflicts without overwriting canonical skills"

section "External skills check wrapper"
CHECK_REPO="$TMP_ROOT/check-repo"
CHECK_SHARED="$TMP_ROOT/check-shared"
mkdir -p "$CHECK_REPO/skills/check-skill"
printf '# Check Skill\n' > "$CHECK_REPO/skills/check-skill/SKILL.md"
"$REPO_ROOT/scripts/pi67-check-external-skills.sh" \
  --repo-root "$REPO_ROOT" \
  --repo "$CHECK_REPO" \
  --skills-dir "$CHECK_SHARED" \
  --json > "$TMP_ROOT/external-check.json"
assert_json_result "$TMP_ROOT/external-check.json" "pi67-external-skills-check/v1" "READY_TO_APPLY"
assert_json_count_at_least "$TMP_ROOT/external-check.json" "counts.missingCanonical" 1
if [ -e "$CHECK_SHARED/check-skill" ]; then
  fail "external check wrapper wrote files"
fi
pass "external check wrapper summarizes dry-run without writing"

section "External skills check wrapper root-level"
CHECK_ROOT_REPO="$TMP_ROOT/check-root-repo"
CHECK_ROOT_SHARED="$TMP_ROOT/check-root-shared"
mkdir -p "$CHECK_ROOT_REPO"
cat > "$CHECK_ROOT_REPO/SKILL.md" <<'EOF'
---
name: check-root-skill
description: Root-level external check fixture.
---
# Check Root Skill
EOF
"$REPO_ROOT/scripts/pi67-check-external-skills.sh" \
  --repo-root "$REPO_ROOT" \
  --repo "$CHECK_ROOT_REPO" \
  --skills-dir "$CHECK_ROOT_SHARED" \
  --json > "$TMP_ROOT/external-check-root.json"
assert_json_result "$TMP_ROOT/external-check-root.json" "pi67-external-skills-check/v1" "READY_TO_APPLY"
assert_external_sync_layout "$TMP_ROOT/external-check-root.json" "check-root-skill" "repo-root"
if [ -e "$CHECK_ROOT_SHARED/check-root-skill" ]; then
  fail "external check root wrapper wrote files"
fi
pass "external check wrapper handles root-level SKILL.md without writing"

CHECK_CONFLICT_REPO="$TMP_ROOT/check-conflict-repo"
CHECK_CONFLICT_SHARED="$TMP_ROOT/check-conflict-shared"
mkdir -p "$CHECK_CONFLICT_REPO/skills/check-conflict" "$CHECK_CONFLICT_SHARED/check-conflict"
printf '# Check Source Conflict\n' > "$CHECK_CONFLICT_REPO/skills/check-conflict/SKILL.md"
printf '# Check Canonical Conflict\n' > "$CHECK_CONFLICT_SHARED/check-conflict/SKILL.md"
if "$REPO_ROOT/scripts/pi67-check-external-skills.sh" \
  --repo-root "$REPO_ROOT" \
  --repo "$CHECK_CONFLICT_REPO" \
  --skills-dir "$CHECK_CONFLICT_SHARED" \
  --json \
  --strict > "$TMP_ROOT/external-check-conflict.json" 2>&1; then
  fail "external check wrapper --strict unexpectedly accepted a conflict"
fi
assert_json_result "$TMP_ROOT/external-check-conflict.json" "pi67-external-skills-check/v1" "NEEDS_REVIEW"
assert_json_count_at_least "$TMP_ROOT/external-check-conflict.json" "counts.conflicts" 1
if ! grep -q 'Check Canonical Conflict' "$CHECK_CONFLICT_SHARED/check-conflict/SKILL.md"; then
  fail "external check wrapper conflict path changed canonical skill"
fi
pass "external check wrapper --strict fails on conflicts without writing"

section "Summary"
pass "skill governance helper tests passed"
