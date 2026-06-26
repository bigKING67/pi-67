#!/usr/bin/env bash
set -euo pipefail

# Remove only pi-67-owned symlinks from a Pi agent directory.
# Local runtime configs, sessions, npm packages, and unrelated files are preserved.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
YES=false
DRY_RUN=false

ASSETS=(
  settings.json
  AGENTS.md
  extensions
  skills
  docs
  prompts
  rules
  scripts
  templates
)

usage() {
  cat <<'USAGE'
pi67-uninstall removes pi-67-owned symlinks only.

Usage:
  scripts/pi67-uninstall.sh [options]

Options:
      --repo-root DIR  Repository root. Defaults to parent of this script.
      --agent-dir DIR  Pi agent dir. Defaults to ~/.pi/agent.
      --dry-run        Print actions without removing symlinks.
  -y, --yes            Required for actual removal.
  -h, --help           Show this help.

Preserved:
  models.json, mcp.json, auth.json, image-gen.json, npm/, sessions/, caches,
  backups, and any non-symlink or non-pi-67-owned target.
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
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--yes)
      YES=true
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

say() {
  echo -e "$*"
}

pass() {
  say "  ${GREEN}PASS${NC} $*"
}

warn() {
  say "  ${YELLOW}WARN${NC} $*"
}

is_pi67_symlink() {
  local target="$1"
  local link_target

  if [ ! -L "$target" ]; then
    return 1
  fi

  link_target="$(readlink "$target")"
  case "$link_target" in
    "$REPO_ROOT"|"$REPO_ROOT"/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_link() {
  local rel="$1"
  local target="$PI_AGENT_DIR/$rel"

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    warn "missing, skipped: $rel"
    return
  fi

  if ! is_pi67_symlink "$target"; then
    warn "not a pi-67-owned symlink, preserved: $target"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} rm $target"
  else
    rm "$target"
  fi
  pass "removed pi-67 symlink: $rel"
}

say ""
say "${CYAN}pi-67 uninstall${NC}"
say "Repository : $REPO_ROOT"
say "Agent dir  : $PI_AGENT_DIR"
say "Mode       : remove pi-67-owned symlinks only"
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi
say ""

if [ "$DRY_RUN" != true ] && [ "$YES" != true ]; then
  say "${RED}Refusing to remove symlinks without --yes.${NC}"
  say "Preview first:"
  say "  scripts/pi67-uninstall.sh --dry-run"
  exit 2
fi

for asset in "${ASSETS[@]}"; do
  remove_link "$asset"
done

say ""
pass "uninstall finished"
say "Local configs and runtime data were preserved."
