#!/usr/bin/env bash
set -euo pipefail

# Safe updater for an existing pi-67 checkout.
# Most assets are symlinked into ~/.pi/agent, so updating the Git checkout is
# usually enough. This script adds guardrails, npm sync, new template creation,
# and doctor verification.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  local dir
  while [ -L "$source" ]; do
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    case "$source" in
      /*) ;;
      *) source="$dir/$source" ;;
    esac
  done
  cd -P "$(dirname "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script_dir)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PI_NPM_DIR="$PI_AGENT_DIR/npm"

REMOTE="origin"
BRANCH=""
DRY_RUN=false
RUN_NPM=true
RUN_DOCTOR=true
ALLOW_DIRTY=false
FORCE_NPM=false

usage() {
  cat <<'USAGE'
pi67-update safely updates an existing pi-67 installation.

Usage:
  scripts/pi67-update.sh [options]

Options:
      --repo-root DIR   pi-67 checkout to update. Defaults to this script's repo.
      --agent-dir DIR   Pi agent dir. Defaults to ~/.pi/agent.
      --remote NAME     Git remote to pull from. Defaults to origin.
      --branch NAME     Git branch to pull. Defaults to current branch.
      --dry-run         Print planned actions without changing files.
      --no-npm          Skip npm dependency sync.
      --force-npm       Run npm install even when package.json did not change.
      --no-doctor       Skip doctor after update.
      --allow-dirty     Allow git pull with a dirty worktree. Default is to stop.
  -h, --help            Show this help.

First update on an old install that does not have this script yet:

  cd /path/to/pi-67
  git pull --ff-only
  bash scripts/pi67-update.sh

After that:

  bash ~/.pi/agent/scripts/pi67-update.sh
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
      PI_NPM_DIR="$PI_AGENT_DIR/npm"
      shift 2
      ;;
    --remote)
      REMOTE="${2:?--remote requires a name}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?--branch requires a name}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-npm)
      RUN_NPM=false
      shift
      ;;
    --force-npm)
      FORCE_NPM=true
      shift
      ;;
    --no-doctor)
      RUN_DOCTOR=false
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
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

fail() {
  say "  ${RED}FAIL${NC} $*" >&2
  exit 1
}

run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $*"
  else
    "$@"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

file_hash() {
  local file="$1"
  if [ ! -f "$file" ]; then
    printf 'missing\n'
    return
  fi
  if command_exists shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command_exists sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  else
    wc -c "$file" | awk '{print "size:" $1}'
  fi
}

copy_example_if_missing() {
  local example_rel="$1"
  local target_rel="$2"
  local example="$REPO_ROOT/$example_rel"
  local target="$PI_AGENT_DIR/$target_rel"

  if [ ! -f "$example" ]; then
    fail "example file missing: $example_rel"
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    pass "$target_rel exists; kept existing local config"
    return
  fi

  run_cmd mkdir -p "$(dirname "$target")"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} copy $example -> $target"
  else
    cp "$example" "$target"
    chmod 600 "$target" 2>/dev/null || true
  fi
  warn "created new local config from template: $target_rel"
}

sync_local_config_templates() {
  say ""
  say "${CYAN}--- local config templates ---${NC}"
  copy_example_if_missing "models.example.json" "models.json"
  copy_example_if_missing "mcp.example.json" "mcp.json"
  copy_example_if_missing "auth.example.json" "auth.json"
  copy_example_if_missing "image-gen.example.json" "image-gen.json"
}

sync_npm() {
  if [ "$RUN_NPM" != true ]; then
    warn "npm sync skipped by --no-npm"
    return
  fi

  if ! command_exists npm; then
    warn "npm not found; skipped npm sync"
    return
  fi

  local repo_pkg="$REPO_ROOT/package.json"
  local agent_pkg="$PI_NPM_DIR/package.json"
  if [ ! -f "$repo_pkg" ]; then
    warn "package.json missing; skipped npm sync"
    return
  fi

  local repo_hash agent_hash
  repo_hash="$(file_hash "$repo_pkg")"
  agent_hash="$(file_hash "$agent_pkg")"

  if [ "$FORCE_NPM" != true ] && [ "$repo_hash" = "$agent_hash" ]; then
    pass "npm package.json already synced"
    return
  fi

  say ""
  say "${CYAN}--- npm sync ---${NC}"
  run_cmd mkdir -p "$PI_NPM_DIR"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} copy $repo_pkg -> $agent_pkg"
    say "  ${CYAN}DRY-RUN${NC} npm install --ignore-scripts in $PI_NPM_DIR"
    return
  fi

  cp "$repo_pkg" "$agent_pkg"
  (
    cd "$PI_NPM_DIR"
    npm install --ignore-scripts
  )
  pass "npm packages synced in $PI_NPM_DIR"
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

  bash "$doctor" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR"
}

update_repo() {
  say ""
  say "${CYAN}--- git update ---${NC}"

  if ! command_exists git; then
    fail "git not found"
  fi

  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "not a git checkout: $REPO_ROOT"
  fi

  local current_branch dirty before after old_version new_version
  current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [ "$current_branch" = "HEAD" ] && [ -z "$BRANCH" ]; then
    fail "detached HEAD; pass --branch explicitly"
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH="$current_branch"
  fi

  dirty="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
  if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" != true ]; then
    say "$dirty" >&2
    fail "repo has local changes; commit/stash them or rerun with --allow-dirty"
  fi
  if [ -n "$dirty" ]; then
    warn "repo has local changes; proceeding because --allow-dirty was provided"
  fi

  before="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  old_version="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} git -C $REPO_ROOT pull --ff-only $REMOTE $BRANCH"
    pass "current revision: $before"
    return
  fi

  git -C "$REPO_ROOT" pull --ff-only "$REMOTE" "$BRANCH"
  after="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  new_version="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"

  if [ "$before" = "$after" ]; then
    pass "already up to date at $after"
  else
    pass "updated $before -> $after"
    if [ -n "$old_version$new_version" ] && [ "$old_version" != "$new_version" ]; then
      pass "version $old_version -> $new_version"
    fi
    say ""
    git -C "$REPO_ROOT" --no-pager log --oneline "$before..$after"
  fi
}

say ""
say "${CYAN}pi-67 updater${NC}"
say "Repository : $REPO_ROOT"
say "Agent dir  : $PI_AGENT_DIR"
say "Remote     : $REMOTE"
if [ -n "$BRANCH" ]; then
  say "Branch     : $BRANCH"
fi
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi

update_repo
sync_local_config_templates
sync_npm
run_doctor

say ""
say "${GREEN}pi-67 update finished${NC}"
