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
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
SKILL_SOURCE_DIR="$REPO_ROOT/shared-skills"
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
RUN_REPORT=true
BACKUP_CREATED=false
DEV_LINK_SKILLS=false
STRICT_SHARED_SKILLS=false

usage() {
  cat <<'USAGE'
pi-67 full installer

Usage:
  ./install.sh [options]

Options:
  -y, --yes            Non-interactive mode. Kept for automation; full install is default.
      --dry-run        Print actions without writing files.
      --agent-dir DIR  Install into DIR instead of ~/.pi/agent.
      --skills-dir DIR Install shared skills into DIR instead of ~/.agents/skills.
      --dev-link-skills
                        Link skills into --skills-dir for local development.
                        Default is copy/install, not symlink.
      --strict-shared-skills
                        Stop when a preserved user-modified global shared
                        skill differs from the pi-67 bundled baseline. Default
                        keeps the existing global skill and continues.
      --backup-dir DIR Write overwritten files into DIR.
      --no-npm         Skip npm package installation.
      --no-doctor      Skip scripts/pi67-doctor.sh after installation.
      --no-report      Skip ~/.pi/agent/pi67-report.json generation.
  -h, --help           Show this help.

Design:
  pi-67 installs the full best-practice configuration by default. Missing API keys,
  local MCP repos, or optional binaries are not removed; doctor reports them as
  readiness warnings after installation.
  Shared skills are installed into ~/.agents/skills so Pi and Codex use one
  active skill registry. ~/.pi/agent is reserved for Pi runtime/config assets.
  If a global shared skill with the same name already exists and differs,
  pi-67 keeps that existing skill by default instead of downgrading it.
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
    --skills-dir)
      SHARED_SKILLS_DIR="${2:?--skills-dir requires a path}"
      shift 2
      ;;
    --dev-link-skills)
      DEV_LINK_SKILLS=true
      shift
      ;;
    --strict-shared-skills)
      STRICT_SHARED_SKILLS=true
      shift
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
    --no-report)
      RUN_REPORT=false
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

verify_in_place_asset() {
  local rel="$1"
  local target="$PI_AGENT_DIR/$rel"
  local tracked

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    say "  ${RED}FAIL${NC} tracked asset missing in in-place checkout: $rel" >&2
    exit 1
  fi

  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    say "  ${RED}FAIL${NC} in-place mode requires a Git checkout: $REPO_ROOT" >&2
    exit 1
  fi

  tracked="$(git -C "$REPO_ROOT" ls-files -- "$rel")"
  if [ -z "$tracked" ]; then
    say "  ${RED}FAIL${NC} asset exists but is not tracked by Git: $rel" >&2
    exit 1
  fi

  pass "tracked asset kept in place: $rel"
}

skill_dir_hash() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    printf 'missing\n'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    (
      cd "$dir"
      find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s\n' "$file"
        shasum -a 256 "$file" | awk '{print $1}'
      done
    ) | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    (
      cd "$dir"
      find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s\n' "$file"
        sha256sum "$file" | awk '{print $1}'
      done
    ) | sha256sum | awk '{print $1}'
  else
    find "$dir" -type f -print | wc -l | awk '{print "files:" $1}'
  fi
}

install_one_shared_skill() {
  local src="$1"
  local name dest src_hash dest_hash
  name="$(basename "$src")"
  dest="$SHARED_SKILLS_DIR/$name"

  if [ ! -f "$src/SKILL.md" ]; then
    warn "shared skill missing SKILL.md, skipped: $name"
    return
  fi

  ensure_dir "$SHARED_SKILLS_DIR"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    src_hash="$(skill_dir_hash "$src")"
    dest_hash="$(skill_dir_hash "$dest")"
    if [ "$src_hash" = "$dest_hash" ] && [ "$dest_hash" != "missing" ]; then
      pass "shared skill already installed: $name"
      return
    fi
    if [ "$STRICT_SHARED_SKILLS" = true ]; then
      say "  ${RED}FAIL${NC} preserved user-modified shared skill differs from pi-67 baseline: $name" >&2
    else
      say "  ${YELLOW}WARN${NC} preserved user-modified shared skill differs from pi-67 baseline: $name" >&2
    fi
    say "       existing: $dest" >&2
    say "       source  : $src" >&2
    say "       existing dir hash: $dest_hash" >&2
    say "       source   dir hash: $src_hash" >&2
    if [ "$STRICT_SHARED_SKILLS" = true ]; then
      say "       strict mode enabled; resolve manually or choose a different --skills-dir" >&2
      exit 1
    fi
    warn "preserved user-modified shared skill; keeping existing global skill: $name"
    warn "source skipped: $src"
    return
  fi

  if [ "$DEV_LINK_SKILLS" = true ]; then
    if [ "$DRY_RUN" = true ]; then
      say "  ${CYAN}DRY-RUN${NC} link $src -> $dest"
    else
      ln -s "$src" "$dest"
    fi
    pass "linked shared skill: $name -> $src"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} copy $src -> $dest"
  else
    cp -R "$src" "$dest"
  fi
  pass "installed shared skill: $name"
}

install_shared_skills() {
  say ""
  say "${CYAN}--- shared skills ---${NC}"

  if [ ! -d "$SKILL_SOURCE_DIR" ]; then
    say "  ${RED}FAIL${NC} shared skill source missing: $SKILL_SOURCE_DIR" >&2
    exit 1
  fi

  local found=false
  while IFS= read -r skill_dir; do
    found=true
    install_one_shared_skill "$skill_dir"
  done < <(find "$SKILL_SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort)

  if [ "$found" != true ]; then
    warn "no shared skills found in $SKILL_SOURCE_DIR"
  else
    pass "shared skills target: $SHARED_SKILLS_DIR"
  fi
}

retire_legacy_agent_skills() {
  local legacy="$PI_AGENT_DIR/skills"

  if [ ! -e "$legacy" ] && [ ! -L "$legacy" ]; then
    pass "no legacy active skill directory under agent dir"
    return
  fi

  say ""
  say "${CYAN}--- legacy skill root ---${NC}"

  if [ "$INSTALL_MODE" = "in-place" ]; then
    warn "legacy active skill root exists in in-place checkout and was left untouched: $legacy"
    warn "remove it manually after confirming the same skills exist in $SHARED_SKILLS_DIR"
    return
  fi

  backup_existing "$legacy" "skills"
  warn "retired legacy active skill root into backup; $SHARED_SKILLS_DIR is canonical"
}

migrate_settings_runtime_state() {
  local tool="$REPO_ROOT/packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs"
  local state_dir="${HOME:-$REPO_ROOT}/.pi/pi67"

  say ""
  say "${CYAN}--- settings runtime state ---${NC}"
  if [ ! -f "$tool" ]; then
    warn "settings runtime state tool missing: $tool"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; skipped settings runtime state migration"
    return
  fi
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} node $tool --migrate --agent-dir $PI_AGENT_DIR --repo-root $REPO_ROOT --state-dir $state_dir --normalize --install-git-filter"
    return
  fi

  node "$tool" \
    --migrate \
    --agent-dir "$PI_AGENT_DIR" \
    --repo-root "$REPO_ROOT" \
    --state-dir "$state_dir" \
    --normalize \
    --install-git-filter
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

patch_until_done_runtime_queue() {
  local patcher="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh"

  say ""
  say "${CYAN}--- pi-until-done runtime queue patch ---${NC}"
  if [ ! -f "$patcher" ]; then
    warn "pi-until-done runtime queue patcher missing: $patcher"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; skipped pi-until-done runtime queue patch"
    return
  fi
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $patcher --apply --agent-dir $PI_AGENT_DIR"
    return
  fi

  bash "$patcher" --apply --agent-dir "$PI_AGENT_DIR"
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
    say "  ${CYAN}DRY-RUN${NC} $doctor --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR --skills-dir $SHARED_SKILLS_DIR"
    return
  fi

  if bash "$doctor" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR" --skills-dir "$SHARED_SKILLS_DIR"; then
    pass "doctor completed"
  else
    warn "doctor found blocking failures; fix the reported items and rerun scripts/pi67-doctor.sh"
  fi
}

write_report() {
  if [ "$RUN_REPORT" != true ]; then
    warn "report skipped by --no-report"
    return
  fi

  local reporter="$REPO_ROOT/scripts/pi67-report.sh"
  if [ ! -f "$reporter" ]; then
    warn "report script missing: $reporter"
    return
  fi

  say ""
  say "${CYAN}--- pi-67 report ---${NC}"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $reporter --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR --skills-dir $SHARED_SKILLS_DIR --operation install"
    return
  fi

  local args=("--repo-root" "$REPO_ROOT" "--agent-dir" "$PI_AGENT_DIR" "--skills-dir" "$SHARED_SKILLS_DIR" "--operation" "install")
  if [ "$RUN_DOCTOR" != true ]; then
    args+=("--no-doctor")
  fi

  if bash "$reporter" "${args[@]}"; then
    pass "report written: $PI_AGENT_DIR/pi67-report.json"
  else
    warn "report generation failed; rerun scripts/pi67-report.sh manually for details"
  fi
}

INSTALL_MODE="$(detect_install_mode)"

say ""
say "${CYAN}╔══════════════════════════════════════════╗${NC}"
say "${CYAN}║        pi-67 full installer             ║${NC}"
say "${CYAN}╚══════════════════════════════════════════╝${NC}"
say ""
say "Repository : ${GREEN}$REPO_ROOT${NC}"
say "Agent dir  : ${GREEN}$PI_AGENT_DIR${NC}"
say "Skills dir : ${GREEN}$SHARED_SKILLS_DIR${NC}"
if [ "$INSTALL_MODE" = "linked" ]; then
  say "Backup dir : ${GREEN}$BACKUP_DIR${NC}"
fi
if [ "$INSTALL_MODE" = "in-place" ]; then
  say "Mode       : ${GREEN}in-place repo${NC}"
  say "Assets     : ${GREEN}tracked in current checkout${NC}"
else
  say "Mode       : ${GREEN}linked install${NC}"
  say "Assets     : ${GREEN}symlinked into agent dir; shared skills copied to skills dir${NC}"
fi
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
if [ "$INSTALL_MODE" = "in-place" ]; then
  say "${CYAN}--- verifying in-place tracked assets ---${NC}"
  verify_in_place_asset "settings.json"
  verify_in_place_asset "AGENTS.md"
  verify_in_place_asset "extensions"
  verify_in_place_asset "shared-skills"
  verify_in_place_asset "docs"
  verify_in_place_asset "prompts"
  verify_in_place_asset "rules"
  verify_in_place_asset "scripts"
  verify_in_place_asset "templates"
else
  say "${CYAN}--- linking full pi-67 assets ---${NC}"
  replace_with_symlink "settings.json" "settings.json"
  replace_with_symlink "AGENTS.md" "AGENTS.md"
  replace_with_symlink "extensions" "extensions"
  replace_with_symlink "docs" "docs"
  replace_with_symlink "prompts" "prompts"
  replace_with_symlink "rules" "rules"
  replace_with_symlink "scripts" "scripts"
  replace_with_symlink "templates" "templates"
fi

install_shared_skills
retire_legacy_agent_skills
migrate_settings_runtime_state

say ""
say "${CYAN}--- local config templates ---${NC}"

copy_example_if_missing "models.example.json" "models.json"
copy_example_if_missing "mcp.example.json" "mcp.json"
copy_example_if_missing "auth.example.json" "auth.json"
copy_example_if_missing "image-gen.example.json" "image-gen.json"

if [ -f "$REPO_ROOT/scripts/pi67-configure.sh" ]; then
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} bash $REPO_ROOT/scripts/pi67-configure.sh --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR --no-prompt --no-doctor --dry-run"
  else
    bash "$REPO_ROOT/scripts/pi67-configure.sh" \
      --repo-root "$REPO_ROOT" \
      --agent-dir "$PI_AGENT_DIR" \
      --no-prompt \
      --no-doctor
  fi
else
  warn "configure script missing; skipped local MCP path normalization"
fi

say ""
say "${CYAN}--- npm packages ---${NC}"
install_npm_packages
patch_until_done_runtime_queue

run_doctor
write_report

say ""
say "${GREEN}╔══════════════════════════════════════════╗${NC}"
say "${GREEN}║        pi-67 install finished           ║${NC}"
say "${GREEN}╚══════════════════════════════════════════╝${NC}"
say ""
say "Next:"
say "  1. Configure local keys/paths: ${CYAN}bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets${NC}"
say "  2. Or manually edit ~/.pi/agent/models.json, mcp.json, auth.json, image-gen.json."
say "  3. Run: ${CYAN}bash ~/.pi/agent/scripts/pi67-doctor.sh${NC}"
say "  4. Status: ${CYAN}bash ~/.pi/agent/scripts/pi67-status.sh${NC}"
say "  5. Report: ${CYAN}~/.pi/agent/pi67-report.json${NC}"
say "  6. Start Pi: ${CYAN}pi${NC}"
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
if [ "$INSTALL_MODE" = "in-place" ]; then
  say "  ${CYAN}git -C ~/.pi/agent pull --ff-only${NC}"
  say "  ${CYAN}bash ~/.pi/agent/scripts/pi67-update.sh${NC}"
else
  say "  ${CYAN}bash ~/.pi/agent/scripts/pi67-update.sh${NC}"
fi
say ""
