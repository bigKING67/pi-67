#!/usr/bin/env bash
set -euo pipefail

# pi-67 full installer
# Default behavior installs the complete Pi workspace distribution.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI_NPM_DIR="$PI_AGENT_DIR/npm"
if [ -n "${BACKUP_DIR:-}" ]; then
  BACKUP_DIR_USER_SET=true
else
  BACKUP_DIR_USER_SET=false
  BACKUP_DIR="$PI_AGENT_DIR/backup-$(date +%Y%m%d-%H%M%S)"
fi

YES=false
DRY_RUN=false
RUN_NPM=true
RUN_DOCTOR=true
BACKUP_CREATED=false

usage() {
  cat <<'USAGE'
pi-67 full installer

Usage:
  ./install.sh [options]

Options:
  -y, --yes            Non-interactive mode. Kept for automation; full install is default.
      --dry-run        Print actions without writing files.
      --agent-dir DIR  Install into DIR instead of ~/.pi/agent.
      --backup-dir DIR Write overwritten files into DIR.
      --no-npm         Skip npm package installation.
      --no-doctor      Skip scripts/pi67-doctor.sh after installation.
  -h, --help           Show this help.

Design:
  pi-67 installs the full best-practice configuration by default. Missing API keys,
  local MCP repos, or optional binaries are not removed; doctor reports them as
  readiness warnings after installation.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)
      YES=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --agent-dir)
      PI_AGENT_DIR="${2:?--agent-dir requires a path}"
      PI_NPM_DIR="$PI_AGENT_DIR/npm"
      if [ "$BACKUP_DIR_USER_SET" = false ]; then
        BACKUP_DIR="$PI_AGENT_DIR/backup-$(date +%Y%m%d-%H%M%S)"
      fi
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a path}"
      BACKUP_DIR_USER_SET=true
      shift 2
      ;;
    --no-npm)
      RUN_NPM=false
      shift
      ;;
    --no-doctor)
      RUN_DOCTOR=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option:${NC} $1" >&2
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

run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $*"
  else
    "$@"
  fi
}

ensure_dir() {
  local dir="$1"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} mkdir -p $dir"
  else
    mkdir -p "$dir"
  fi
}

ensure_backup_dir() {
  if [ "$BACKUP_CREATED" = true ]; then
    return
  fi
  ensure_dir "$BACKUP_DIR"
  BACKUP_CREATED=true
  pass "backup directory ready: $BACKUP_DIR"
}

unique_backup_path() {
  local rel="$1"
  local candidate="$BACKUP_DIR/$rel"
  local index=1
  while [ -e "$candidate" ] || [ -L "$candidate" ]; do
    candidate="$BACKUP_DIR/$rel.$index"
    index=$((index + 1))
  done
  printf '%s\n' "$candidate"
}

backup_existing() {
  local dest="$1"
  local rel="$2"
  local backup_path

  ensure_backup_dir
  backup_path="$(unique_backup_path "$rel")"
  ensure_dir "$(dirname "$backup_path")"

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} move $dest -> $backup_path"
  else
    mv "$dest" "$backup_path"
  fi
  pass "backed up existing $rel -> $backup_path"
}

replace_with_symlink() {
  local src_rel="$1"
  local dest_rel="$2"
  local required="${3:-required}"
  local src="$REPO_ROOT/$src_rel"
  local dest="$PI_AGENT_DIR/$dest_rel"

  if [ ! -e "$src" ]; then
    if [ "$required" = "optional" ]; then
      warn "optional source missing, skipped: $src_rel"
      return
    fi
    say "  ${RED}FAIL${NC} required source missing: $src_rel" >&2
    exit 1
  fi

  ensure_dir "$(dirname "$dest")"

  if [ -L "$dest" ]; then
    run_cmd rm -f "$dest"
  elif [ -e "$dest" ]; then
    backup_existing "$dest" "$dest_rel"
  fi

  run_cmd ln -sfn "$src" "$dest"
  pass "$dest_rel -> $src"
}

copy_example_if_missing() {
  local example_rel="$1"
  local target_rel="$2"
  local example="$REPO_ROOT/$example_rel"
  local target="$PI_AGENT_DIR/$target_rel"

  if [ ! -f "$example" ]; then
    say "  ${RED}FAIL${NC} example file missing: $example_rel" >&2
    exit 1
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    pass "$target_rel already exists; kept existing local config"
    return
  fi

  ensure_dir "$(dirname "$target")"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} copy $example -> $target"
  else
    cp "$example" "$target"
    chmod 600 "$target" 2>/dev/null || true
  fi
  warn "created $target_rel from $example_rel; fill placeholders before using gated capabilities"
}

install_npm_packages() {
  if [ "$RUN_NPM" != true ]; then
    warn "npm package installation skipped by --no-npm"
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    say "  ${RED}FAIL${NC} npm not found; rerun with --no-npm or install Node/npm" >&2
    exit 1
  fi

  if [ ! -f "$REPO_ROOT/package.json" ]; then
    warn "package.json missing; skipped npm package installation"
    return
  fi

  ensure_dir "$PI_NPM_DIR"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} copy package.json and run npm install --ignore-scripts in $PI_NPM_DIR"
    return
  fi

  cp "$REPO_ROOT/package.json" "$PI_NPM_DIR/package.json"
  (
    cd "$PI_NPM_DIR"
    npm install --ignore-scripts
  )
  pass "npm packages installed in $PI_NPM_DIR"
}

run_doctor() {
  if [ "$RUN_DOCTOR" != true ]; then
    warn "doctor skipped by --no-doctor"
    return
  fi

  local doctor="$REPO_ROOT/scripts/pi67-doctor.sh"
  if [ ! -f "$doctor" ]; then
    warn "doctor script missing: $doctor"
    return
  fi

  say ""
  say "${CYAN}--- pi-67 doctor ---${NC}"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $doctor --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR"
    return
  fi

  if bash "$doctor" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR"; then
    pass "doctor completed"
  else
    warn "doctor found blocking failures; fix the reported items and rerun scripts/pi67-doctor.sh"
  fi
}

say ""
say "${CYAN}╔══════════════════════════════════════════╗${NC}"
say "${CYAN}║        pi-67 full installer             ║${NC}"
say "${CYAN}╚══════════════════════════════════════════╝${NC}"
say ""
say "Repository : ${GREEN}$REPO_ROOT${NC}"
say "Agent dir  : ${GREEN}$PI_AGENT_DIR${NC}"
say "Backup dir : ${GREEN}$BACKUP_DIR${NC}"
say "Mode       : ${GREEN}full install by default${NC}"
if [ "$YES" = true ]; then
  say "Noninteractive: ${GREEN}yes${NC}"
fi
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi
say ""

if ! command -v pi >/dev/null 2>&1; then
  say "${RED}pi command not found.${NC}"
  say "Install Pi first:"
  say "  npm install -g @earendil-works/pi-coding-agent"
  exit 1
fi

pass "pi found: $(pi --version 2>/dev/null || echo unknown)"
ensure_dir "$PI_AGENT_DIR"

say ""
say "${CYAN}--- linking full pi-67 assets ---${NC}"

replace_with_symlink "settings.json" "settings.json"
replace_with_symlink "AGENTS.md" "AGENTS.md"
replace_with_symlink "extensions" "extensions"
replace_with_symlink "skills" "skills"
replace_with_symlink "docs" "docs"
replace_with_symlink "prompts" "prompts"
replace_with_symlink "rules" "rules"
replace_with_symlink "scripts" "scripts"
replace_with_symlink "templates" "templates"

say ""
say "${CYAN}--- local config templates ---${NC}"

copy_example_if_missing "models.example.json" "models.json"
copy_example_if_missing "mcp.example.json" "mcp.json"
copy_example_if_missing "auth.example.json" "auth.json"
copy_example_if_missing "image-gen.example.json" "image-gen.json"

say ""
say "${CYAN}--- npm packages ---${NC}"
install_npm_packages

run_doctor

say ""
say "${GREEN}╔══════════════════════════════════════════╗${NC}"
say "${GREEN}║        pi-67 install finished           ║${NC}"
say "${GREEN}╚══════════════════════════════════════════╝${NC}"
say ""
say "Next:"
say "  1. Configure local keys/paths: ${CYAN}bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets${NC}"
say "  2. Or manually edit ~/.pi/agent/models.json, mcp.json, auth.json, image-gen.json."
say "  3. Run: ${CYAN}bash ~/.pi/agent/scripts/pi67-doctor.sh${NC}"
say "  4. Start Pi: ${CYAN}pi${NC}"
if [ "$BACKUP_CREATED" = true ]; then
  say ""
  if [ "$DRY_RUN" = true ]; then
    say "Backup would be saved at: ${CYAN}$BACKUP_DIR${NC}"
  else
    say "Backup saved at: ${CYAN}$BACKUP_DIR${NC}"
  fi
fi
say ""
say "Update later:"
say "  cd $REPO_ROOT && git pull"
say ""
