#!/usr/bin/env bash
set -euo pipefail

# Validate a clean pi-67 artifact copy/ref without touching the real Pi config.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_URL=""
REF="WORKTREE"
KEEP_TMP=false
TMP_ROOT=""

usage() {
  cat <<'USAGE'
pi67-release-artifact-smoke validates a clean install/release-check artifact.

Usage:
  scripts/pi67-release-artifact-smoke.sh [options]

Options:
      --repo-root DIR  Local pi-67 repository root. Defaults to this script's parent.
      --repo-url URL   Clone source. Defaults to --repo-root for ref clones.
      --ref REF        Ref to verify. Defaults to WORKTREE.
                       Use WORKTREE for the current local candidate, HEAD for the
                       committed default branch state, or a tag such as v0.9.0.
      --keep-tmp       Keep temporary artifact directory for inspection.
  -h, --help           Show this help.

Examples:
  bash scripts/pi67-release-artifact-smoke.sh
  bash scripts/pi67-release-artifact-smoke.sh --ref HEAD
  bash scripts/pi67-release-artifact-smoke.sh --ref v0.9.0
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:?--repo-url requires a URL or path}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref requires a ref}"
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

if [ -n "$REPO_URL" ] && [ "$REF" = "WORKTREE" ]; then
  REF="HEAD"
fi

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

echo ""
echo -e "${CYAN}pi-67 release artifact smoke${NC}"
echo "Repository: $REPO_ROOT"
echo "Ref       : $REF"

command_exists git || fail "git is required"
command_exists node || fail "node is required"
if [ "$(git -C "$REPO_ROOT" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
  fail "repo root is not a Git checkout: $REPO_ROOT"
fi
pass "required tools found"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-release-artifact.XXXXXX")"
ARTIFACT_DIR="$TMP_ROOT/artifact"

copy_worktree_candidate() {
  mkdir -p "$ARTIFACT_DIR"
  while IFS= read -r -d '' file; do
    if [ ! -e "$REPO_ROOT/$file" ] && [ ! -L "$REPO_ROOT/$file" ]; then
      continue
    fi
    mkdir -p "$ARTIFACT_DIR/$(dirname "$file")"
    cp -p "$REPO_ROOT/$file" "$ARTIFACT_DIR/$file"
  done < <(git -C "$REPO_ROOT" ls-files -z --cached --others --exclude-standard)

  git -C "$ARTIFACT_DIR" init -q
  git -C "$ARTIFACT_DIR" config user.email "pi67-release-artifact@example.invalid"
  git -C "$ARTIFACT_DIR" config user.name "pi67 release artifact smoke"
  git -C "$ARTIFACT_DIR" add .
  git -C "$ARTIFACT_DIR" commit -q -m "pi67 release artifact smoke candidate"
}

section "Build artifact"
if [ "$REF" = "WORKTREE" ]; then
  copy_worktree_candidate
  pass "copied current worktree candidate"
else
  CLONE_SOURCE="${REPO_URL:-$REPO_ROOT}"
  git clone --no-hardlinks "$CLONE_SOURCE" "$ARTIFACT_DIR" > "$TMP_ROOT/clone.log" 2>&1
  if [ "$REF" != "HEAD" ]; then
    git -C "$ARTIFACT_DIR" checkout --detach "$REF" > "$TMP_ROOT/checkout.log" 2>&1
  fi
  pass "cloned artifact source"
fi

[ -f "$ARTIFACT_DIR/install.sh" ] || fail "artifact missing install.sh"
[ -f "$ARTIFACT_DIR/scripts/pi67-release-check.sh" ] || fail "artifact missing release check"
[ -f "$ARTIFACT_DIR/scripts/pi67-migrate-skills.sh" ] || fail "artifact missing skill migration helper"

FAKE_BIN="$TMP_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/pi" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version)
    echo "0.0.0-release-artifact-smoke"
    ;;
  skill)
    if [ "${2:-}" = "list" ]; then
      echo "release artifact smoke skill list"
    else
      echo "release artifact smoke pi skill"
    fi
    ;;
  *)
    echo "release artifact smoke pi"
    ;;
esac
SH
chmod +x "$FAKE_BIN/pi"

section "Install dry-run"
PATH="$FAKE_BIN:$PATH" "$ARTIFACT_DIR/install.sh" \
  --dry-run \
  --agent-dir "$TMP_ROOT/agent" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --backup-dir "$TMP_ROOT/backup" \
  --no-npm \
  --no-doctor \
  --no-report \
  --yes > "$TMP_ROOT/install-dry-run.log"
pass "install dry-run completed"

section "Release metadata check"
bash "$ARTIFACT_DIR/scripts/pi67-release-check.sh" > "$TMP_ROOT/release-check.log"
pass "release check completed"

section "Skill migration schema check"
bash "$ARTIFACT_DIR/scripts/pi67-migrate-skills.sh" \
  --agent-dir "$TMP_ROOT/agent" \
  --skills-dir "$TMP_ROOT/shared-skills" \
  --backup-dir "$TMP_ROOT/backup/skill-migration" \
  --dry-run \
  --json > "$TMP_ROOT/migrate-skills.json"
node - "$TMP_ROOT/migrate-skills.json" <<'NODE'
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.schemaId !== "pi67-skill-migration/v1") {
  throw new Error(`unexpected schemaId: ${data.schemaId}`);
}
if (!["NOOP", "READY_TO_APPLY"].includes(data.result)) {
  throw new Error(`unexpected migration result: ${data.result}`);
}
NODE
pass "skill migration JSON schema accepted"

section "Summary"
pass "release artifact smoke passed"
