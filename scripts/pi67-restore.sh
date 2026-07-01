#!/usr/bin/env bash
set -euo pipefail

# Restore files/directories from a pi-67 installer backup directory.
# For safety, this only overwrites missing targets or current symlinks.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
BACKUP_DIR=""
YES=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
pi67-restore restores files/directories from a pi-67 backup.

Usage:
  scripts/pi67-restore.sh --backup-dir DIR [options]

Options:
      --backup-dir DIR  Required backup directory, e.g. ~/.pi/agent/backup-20260626-193000.
      --repo-root DIR   Repository root. Defaults to parent of this script.
      --agent-dir DIR   Pi agent dir. Defaults to ~/.pi/agent.
      --dry-run         Print actions without writing files.
  -y, --yes             Required for actual restore.
  -h, --help            Show this help.

Safety:
  Existing non-symlink targets are preserved and skipped. Remove or move them
  manually first if you intentionally want to replace them.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a path}"
      shift 2
      ;;
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

fail() {
  say "  ${RED}FAIL${NC} $*" >&2
  exit 1
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

restore_entry() {
  local name="$1"
  local src="$BACKUP_DIR/$name"
  local dest="$PI_AGENT_DIR/$name"

  if [ ! -e "$src" ] && [ ! -L "$src" ]; then
    return
  fi

  if [ "$INSTALL_MODE" = "in-place" ] && git_tracks_path "$name"; then
    warn "tracked asset preserved in in-place checkout, skipped: $name"
    warn "use git restore $name if you need to restore tracked source"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} mkdir -p $(dirname "$dest")"
  else
    mkdir -p "$(dirname "$dest")"
  fi

  if [ -L "$dest" ]; then
    if [ "$DRY_RUN" = true ]; then
      say "  ${CYAN}DRY-RUN${NC} rm $dest"
    else
      rm "$dest"
    fi
  elif [ -e "$dest" ]; then
    warn "existing non-symlink preserved, skipped: $dest"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} cp -R $src -> $dest"
  else
    cp -R "$src" "$dest"
  fi
  pass "restored: $name"
}

if [ -z "$BACKUP_DIR" ]; then
  usage >&2
  exit 2
fi

if [ ! -d "$BACKUP_DIR" ]; then
  fail "backup directory not found: $BACKUP_DIR"
fi

INSTALL_MODE="$(detect_install_mode)"

say ""
say "${CYAN}pi-67 restore${NC}"
say "Backup dir: $BACKUP_DIR"
say "Agent dir : $PI_AGENT_DIR"
say "Mode      : $INSTALL_MODE"
if [ "$DRY_RUN" = true ]; then
  say "Dry run   : ${YELLOW}yes${NC}"
fi
say ""

if [ "$DRY_RUN" != true ] && [ "$YES" != true ]; then
  say "${RED}Refusing to restore without --yes.${NC}"
  say "Preview first:"
  say "  scripts/pi67-restore.sh --backup-dir $BACKUP_DIR --dry-run"
  exit 2
fi

restored=0
for entry in "$BACKUP_DIR"/*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  restore_entry "$name"
  restored=$((restored + 1))
done

if [ "$restored" -eq 0 ]; then
  warn "backup directory has no restorable entries"
else
  pass "restore finished"
fi
