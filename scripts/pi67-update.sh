#!/usr/bin/env bash
set -euo pipefail

# Safe updater for an existing pi-67 checkout.
# Supports both linked installs and in-place repos where ~/.pi/agent is the checkout.

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
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
SKILL_SOURCE_DIR="$REPO_ROOT/shared-skills"
NPM_INSTALL_ARGS=(install --ignore-scripts --no-audit --no-fund --prefer-offline)

REMOTE="origin"
BRANCH=""
DRY_RUN=false
CHECK_ONLY=false
RUN_NPM=true
RUN_DOCTOR=true
RUN_REPORT=true
RUN_CONFIGURE=true
ALLOW_DIRTY=false
FORCE_NPM=false
DEV_LINK_SKILLS=false
STRICT_SHARED_SKILLS=false
PRESERVED_RUNTIME_FILES=(
  "settings.json"
  "models.json"
  "auth.json"
  "mcp.json"
  "image-gen.json"
  "settings.json.theme"
)
PRESERVED_RUNTIME_BACKUP_DIR=""
PRESERVED_RUNTIME_BACKUP_PATHS=()

usage() {
  cat <<'USAGE'
pi67-update safely updates an existing pi-67 installation.

Usage:
  scripts/pi67-update.sh [options]

Options:
      --repo-root DIR   pi-67 checkout to update. Defaults to this script's repo.
      --agent-dir DIR   Pi agent dir. Defaults to ~/.pi/agent.
      --skills-dir DIR  Sync shared skills into DIR instead of ~/.agents/skills.
      --dev-link-skills Link skills into --skills-dir for local development.
      --strict-shared-skills
                        Stop when an existing global shared skill differs from
                        the pi-67 bundled baseline. Default keeps the existing
                        global skill and continues.
      --remote NAME     Git remote to pull from. Defaults to origin.
      --branch NAME     Git branch to pull. Defaults to current branch.
      --dry-run         Print planned actions without changing files.
      --check-only      Inspect update/report status without pulling or writing files.
      --no-npm          Skip npm dependency sync.
      --force-npm       Run npm install even when package.json did not change.
      --no-configure    Skip local config migration/normalization after update.
      --no-doctor       Skip doctor after update.
      --no-report       Skip ~/.pi/agent/pi67-report.json generation.
      --allow-dirty     Allow git pull with a dirty worktree. Default is to stop.
                        Dirty user runtime config files are backed up and
                        restored automatically; other tracked edits still stop.
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
    --check-only)
      CHECK_ONLY=true
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
    --no-configure)
      RUN_CONFIGURE=false
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

real_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    (cd "$dir" && pwd -P)
  else
    printf '%s\n' "$dir"
  fi
}

repo_status_path() {
  local line="$1"
  local file="${line:3}"
  file="${file#"${file%%[![:space:]]*}"}"
  if [[ "$file" == *" -> "* ]]; then
    file="${file##* -> }"
  fi
  if [[ "$file" == \"*\" ]]; then
    file="${file#\"}"
    file="${file%\"}"
  fi
  printf '%s\n' "${file//\\//}"
}

is_preserved_runtime_file() {
  local candidate="$1"
  local rel
  for rel in "${PRESERVED_RUNTIME_FILES[@]}"; do
    if [ "$candidate" = "$rel" ]; then
      return 0
    fi
  done
  return 1
}

backup_and_clear_preserved_runtime_edits() {
  local -a dirty_paths=("$@")
  if [ "${#dirty_paths[@]}" -eq 0 ]; then
    return 0
  fi

  local stamp backup_dir rel source safe_name
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$HOME/.pi/pi67/backups/pre-update-runtime-$stamp"
  PRESERVED_RUNTIME_BACKUP_DIR="$backup_dir"
  PRESERVED_RUNTIME_BACKUP_PATHS=("${dirty_paths[@]}")

  warn "tracked edits are limited to user-owned runtime config files"
  warn "backing them up and restoring them after git update: $backup_dir"

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} backup preserved runtime files to $backup_dir"
    say "  ${CYAN}DRY-RUN${NC} git -C $REPO_ROOT restore --worktree --staged -- ${dirty_paths[*]}"
    return 0
  fi

  mkdir -p "$backup_dir/files"
  git -C "$REPO_ROOT" diff -- "${dirty_paths[@]}" > "$backup_dir/local.diff" || true
  for rel in "${dirty_paths[@]}"; do
    source="$REPO_ROOT/$rel"
    safe_name="${rel//\//__}"
    if [ -f "$source" ]; then
      cp "$source" "$backup_dir/files/$safe_name"
      chmod 600 "$backup_dir/files/$safe_name" 2>/dev/null || true
    fi
  done
  cat > "$backup_dir/manifest.json" <<EOF
{
  "schema": "pi67.runtime-preserve-backup.v1",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repoRoot": "$REPO_ROOT",
  "paths": [$(printf '"%s",' "${dirty_paths[@]}" | sed 's/,$//')]
}
EOF
  chmod 600 "$backup_dir/manifest.json" 2>/dev/null || true
  git -C "$REPO_ROOT" restore --worktree --staged -- "${dirty_paths[@]}"
}

restore_preserved_runtime_edits() {
  if [ -z "$PRESERVED_RUNTIME_BACKUP_DIR" ] || [ "${#PRESERVED_RUNTIME_BACKUP_PATHS[@]}" -eq 0 ]; then
    return 0
  fi
  local rel source target safe_name
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} restore preserved runtime files from $PRESERVED_RUNTIME_BACKUP_DIR"
    return 0
  fi
  for rel in "${PRESERVED_RUNTIME_BACKUP_PATHS[@]}"; do
    safe_name="${rel//\//__}"
    source="$PRESERVED_RUNTIME_BACKUP_DIR/files/$safe_name"
    target="$REPO_ROOT/$rel"
    if [ -f "$source" ]; then
      mkdir -p "$(dirname "$target")"
      cp "$source" "$target"
      chmod 600 "$target" 2>/dev/null || true
    elif [ -e "$target" ] || [ -L "$target" ]; then
      rm -f "$target"
    fi
  done
  pass "restored preserved runtime config after update"
  PRESERVED_RUNTIME_BACKUP_DIR=""
  PRESERVED_RUNTIME_BACKUP_PATHS=()
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

skill_dir_hash() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    printf 'missing\n'
    return
  fi
  if command_exists shasum; then
    (
      cd "$dir"
      find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s\n' "$file"
        shasum -a 256 "$file" | awk '{print $1}'
      done
    ) | shasum -a 256 | awk '{print $1}'
  elif command_exists sha256sum; then
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

sync_one_shared_skill() {
  local src="$1"
  local name dest src_hash dest_hash
  name="$(basename "$src")"
  dest="$SHARED_SKILLS_DIR/$name"

  if [ ! -f "$src/SKILL.md" ]; then
    warn "shared skill missing SKILL.md, skipped: $name"
    return
  fi

  run_cmd mkdir -p "$SHARED_SKILLS_DIR"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    src_hash="$(skill_dir_hash "$src")"
    dest_hash="$(skill_dir_hash "$dest")"
    if [ "$src_hash" = "$dest_hash" ] && [ "$dest_hash" != "missing" ]; then
      pass "shared skill already synced: $name"
      return
    fi
    if [ "$STRICT_SHARED_SKILLS" = true ]; then
      fail "shared skill conflict: $name (existing=$dest dirHash=$dest_hash source=$src dirHash=$src_hash). Strict mode enabled; resolve manually or choose a different --skills-dir."
    fi
    warn "shared skill differs from pi-67 baseline; keeping existing global skill: $name"
    warn "existing=$dest dirHash=$dest_hash"
    warn "source skipped=$src dirHash=$src_hash"
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
  pass "synced shared skill: $name"
}

sync_shared_skills() {
  say ""
  say "${CYAN}--- shared skills ---${NC}"

  if [ ! -d "$SKILL_SOURCE_DIR" ]; then
    fail "shared skill source missing: $SKILL_SOURCE_DIR"
  fi

  local found=false
  while IFS= read -r skill_dir; do
    found=true
    sync_one_shared_skill "$skill_dir"
  done < <(find "$SKILL_SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort)

  if [ "$found" != true ]; then
    warn "no shared skills found in $SKILL_SOURCE_DIR"
  else
    pass "shared skills target: $SHARED_SKILLS_DIR"
  fi
}

retire_legacy_agent_skills() {
  local legacy="$PI_AGENT_DIR/skills"
  local link_target=""

  if [ ! -e "$legacy" ] && [ ! -L "$legacy" ]; then
    pass "no legacy active skill directory under agent dir"
    return
  fi

  say ""
  say "${CYAN}--- legacy skill root ---${NC}"

  if [ -L "$legacy" ]; then
    link_target="$(readlink "$legacy" || true)"
    case "$link_target" in
      "$REPO_ROOT"|"$REPO_ROOT"/*)
        run_cmd rm -f "$legacy"
        pass "removed legacy active skill symlink: $legacy"
        return
        ;;
    esac
    warn "legacy active skill symlink is not pi-67-owned; preserved: $legacy -> $link_target"
    return
  fi

  warn "legacy active skill directory exists and was preserved: $legacy"
  warn "move it out manually after confirming the same skills exist in $SHARED_SKILLS_DIR"
}

report_check() {
  local report="$PI_AGENT_DIR/pi67-report.json"
  local current_version="$1"
  local current_short="$2"
  local current_dirty="$3"

  say ""
  say "${CYAN}--- report status ---${NC}"

  if [ "$RUN_REPORT" != true ]; then
    warn "report generation disabled by --no-report"
    return
  fi

  if [ ! -f "$report" ]; then
    warn "report missing; update would write $report"
    return
  fi

  if ! command_exists node; then
    warn "node not found; cannot parse $report"
    return
  fi

  node - "$report" "$current_version" "$current_short" "$current_dirty" <<'NODE'
const fs = require("fs");

const [, , reportPath, currentVersion, currentShort, currentDirtyArg] = process.argv;
const currentDirty = currentDirtyArg === "true";

function line(level, message) {
  const prefix = level === "PASS" ? "  PASS" : level === "WARN" ? "  WARN" : "  INFO";
  console.log(`${prefix} ${message}`);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  line("WARN", `report is not valid JSON: ${error.message}`);
  process.exit(0);
}

line("INFO", `report path: ${reportPath}`);
line("INFO", `generatedAt: ${report.generatedAt || "unknown"}`);
line("INFO", `schemaVersion: ${report.schemaVersion ?? "missing"}`);
line("INFO", `pi67Version: ${report.pi67Version || "unknown"}`);
line("INFO", `commit: ${report.repository?.shortCommit || "unknown"}`);
line("INFO", `doctor: ${report.doctor?.result || (report.doctor?.skipped ? "SKIPPED" : "unknown")}`);
if (report.doctor && report.doctor.skipped !== true) {
  line("INFO", `doctorSchema: ${report.doctor.schemaVersion ?? "missing"}`);
}

const staleReasons = [];
if (Number(report.schemaVersion || 0) < 2) {
  staleReasons.push(`schemaVersion ${report.schemaVersion ?? "missing"} < 2`);
}
if (String(report.pi67Version || "") !== currentVersion) {
  staleReasons.push(`version ${report.pi67Version || "unknown"} != ${currentVersion}`);
}
if (String(report.repository?.shortCommit || "") !== currentShort) {
  staleReasons.push(`commit ${report.repository?.shortCommit || "unknown"} != ${currentShort}`);
}
if (Boolean(report.repository?.dirty) !== currentDirty) {
  staleReasons.push(`dirty ${Boolean(report.repository?.dirty)} != ${currentDirty}`);
}
if (report.doctor && report.doctor.skipped !== true && Number(report.doctor.schemaVersion || 0) < 2) {
  staleReasons.push(`doctor schemaVersion ${report.doctor.schemaVersion ?? "missing"} < 2`);
}

if (staleReasons.length > 0) {
  line("WARN", `report is stale: ${staleReasons.join("; ")}`);
  line("INFO", "update would overwrite the report after doctor");
} else {
  line("PASS", "report matches current checkout");
}
NODE
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
    say "  ${CYAN}DRY-RUN${NC} npm ${NPM_INSTALL_ARGS[*]} in $PI_NPM_DIR"
    return
  fi

  cp "$repo_pkg" "$agent_pkg"
  (
    cd "$PI_NPM_DIR"
    npm "${NPM_INSTALL_ARGS[@]}"
  )
  pass "npm packages synced in $PI_NPM_DIR"
}

patch_until_done_runtime_queue() {
  local patcher="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh"

  say ""
  say "${CYAN}--- pi-until-done runtime queue patch ---${NC}"
  if [ ! -f "$patcher" ]; then
    warn "pi-until-done runtime queue patcher missing: $patcher"
    return
  fi
  if ! command_exists node; then
    warn "node not found; skipped pi-until-done runtime queue patch"
    return
  fi
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $patcher --apply --agent-dir $PI_AGENT_DIR"
    return
  fi

  bash "$patcher" --apply --agent-dir "$PI_AGENT_DIR"
}

check_npm_status() {
  say ""
  say "${CYAN}--- npm status ---${NC}"

  if [ "$RUN_NPM" != true ]; then
    warn "npm sync disabled by --no-npm"
    return
  fi

  if ! command_exists npm; then
    warn "npm not found; update would skip npm sync"
    return
  fi

  local repo_pkg="$REPO_ROOT/package.json"
  local agent_pkg="$PI_NPM_DIR/package.json"
  if [ ! -f "$repo_pkg" ]; then
    warn "package.json missing; update would skip npm sync"
    return
  fi

  local repo_hash agent_hash
  repo_hash="$(file_hash "$repo_pkg")"
  agent_hash="$(file_hash "$agent_pkg")"

  if [ "$FORCE_NPM" = true ]; then
    warn "npm sync would run because --force-npm is set"
  elif [ "$repo_hash" = "$agent_hash" ]; then
    pass "npm package.json already synced"
  else
    warn "npm package.json differs; update would run npm ${NPM_INSTALL_ARGS[*]}"
  fi
}

check_until_done_runtime_queue_status() {
  local patcher="$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.sh"

  say ""
  say "${CYAN}--- pi-until-done runtime queue/progress compatibility ---${NC}"
  if [ ! -f "$patcher" ]; then
    warn "pi-until-done runtime queue patcher missing"
    return
  fi
  if ! command_exists node; then
    warn "node not found; skipped pi-until-done runtime queue/progress compatibility check"
    return
  fi
  if bash "$patcher" --check --agent-dir "$PI_AGENT_DIR" >/dev/null 2>&1; then
    pass "pi-until-done runtime queue/progress compatibility is already patched or package is not installed"
  else
    warn "pi-until-done runtime queue/progress compatibility would be patched after npm sync"
  fi
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

  bash "$doctor" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR" --skills-dir "$SHARED_SKILLS_DIR"
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
    say "  ${CYAN}DRY-RUN${NC} $reporter --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR --skills-dir $SHARED_SKILLS_DIR --operation update"
    return
  fi

  local args=("--repo-root" "$REPO_ROOT" "--agent-dir" "$PI_AGENT_DIR" "--skills-dir" "$SHARED_SKILLS_DIR" "--operation" "update")
  if [ "$RUN_DOCTOR" != true ]; then
    args+=("--no-doctor")
  fi

  if bash "$reporter" "${args[@]}"; then
    pass "report written: $PI_AGENT_DIR/pi67-report.json"
  else
    warn "report generation failed; rerun scripts/pi67-report.sh manually for details"
  fi
}

check_local_config_templates() {
  say ""
  say "${CYAN}--- local config templates ---${NC}"

  local missing=0
  local pair example_rel target_rel example target
  for pair in \
    "models.example.json:models.json" \
    "mcp.example.json:mcp.json" \
    "auth.example.json:auth.json" \
    "image-gen.example.json:image-gen.json"; do
    example_rel="${pair%%:*}"
    target_rel="${pair#*:}"
    example="$REPO_ROOT/$example_rel"
    target="$PI_AGENT_DIR/$target_rel"

    if [ ! -f "$example" ]; then
      warn "example file missing: $example_rel"
      continue
    fi

    if [ -e "$target" ] || [ -L "$target" ]; then
      pass "$target_rel exists"
    else
      missing=$((missing + 1))
      warn "$target_rel missing; update would create it from $example_rel"
    fi
  done

  if [ "$missing" -eq 0 ]; then
    pass "all local config files exist"
  fi
}

run_configure() {
  if [ "$RUN_CONFIGURE" != true ]; then
    warn "local config migration skipped by --no-configure"
    return
  fi

  local configure="$REPO_ROOT/scripts/pi67-configure.sh"
  if [ ! -f "$configure" ]; then
    warn "configure script missing: $configure"
    return
  fi

  say ""
  say "${CYAN}--- local config migration ---${NC}"
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $configure --repo-root $REPO_ROOT --agent-dir $PI_AGENT_DIR --no-prompt --no-doctor"
    return
  fi

  bash "$configure" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR" --no-prompt --no-doctor
}

check_update_plan() {
  say ""
  say "${CYAN}--- check only ---${NC}"

  if ! command_exists git; then
    fail "git not found"
  fi

  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "not a git checkout: $REPO_ROOT"
  fi

  local current_branch dirty local_full local_short current_version remote_ref remote_full remote_short upstream ahead behind
  current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [ "$current_branch" = "HEAD" ] && [ -z "$BRANCH" ]; then
    fail "detached HEAD; pass --branch explicitly"
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH="$current_branch"
  fi

  dirty="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
  local_full="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  local_short="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  current_version="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"

  say "Local branch : ${GREEN}$current_branch${NC}"
  say "Target branch: ${GREEN}$BRANCH${NC}"
  say "Local commit : ${GREEN}$local_short${NC}"
  if [ -n "$current_version" ]; then
    say "Local version: ${GREEN}$current_version${NC}"
  fi

  if [ -n "$dirty" ]; then
    local -a dirty_tracked_paths=()
    local -a unsafe_dirty_paths=()
    local line rel
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      rel="$(repo_status_path "$line")"
      dirty_tracked_paths+=("$rel")
      if ! is_preserved_runtime_file "$rel"; then
        unsafe_dirty_paths+=("$rel")
      fi
    done < <(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=no)
    if [ "${#dirty_tracked_paths[@]}" -gt 0 ] && [ "${#unsafe_dirty_paths[@]}" -eq 0 ]; then
      warn "repo has dirty user runtime config; update would back up and restore it"
    elif [ "${#unsafe_dirty_paths[@]}" -gt 0 ]; then
      warn "repo has non-runtime local changes; real update would stop unless --allow-dirty is used"
    else
      warn "repo has only untracked local files; update would preserve them unless Git reports a path collision"
    fi
    say "$dirty"
  else
    pass "repo worktree is clean"
  fi

  remote_ref="refs/heads/$BRANCH"
  remote_full="$(git -C "$REPO_ROOT" ls-remote "$REMOTE" "$remote_ref" 2>/dev/null | awk 'NR == 1 {print $1}')"
  if [ -z "$remote_full" ]; then
    warn "could not read remote head: $REMOTE $remote_ref"
  else
    remote_short="$(printf '%s\n' "$remote_full" | cut -c1-7)"
    say "Remote head : ${GREEN}$remote_short${NC} ($REMOTE/$BRANCH)"
    if [ "$remote_full" = "$local_full" ]; then
      pass "local checkout matches remote head"
    elif git -C "$REPO_ROOT" cat-file -e "$remote_full^{commit}" 2>/dev/null; then
      if git -C "$REPO_ROOT" merge-base --is-ancestor "$local_full" "$remote_full" 2>/dev/null; then
        warn "local checkout is behind remote; update would fast-forward"
      elif git -C "$REPO_ROOT" merge-base --is-ancestor "$remote_full" "$local_full" 2>/dev/null; then
        warn "local checkout is ahead of remote; update would likely be a no-op after pull"
      else
        warn "local and remote appear diverged; update would fail because it uses --ff-only"
      fi
    else
      warn "remote has a different commit not present locally; update would fetch/pull it"
    fi
  fi

  if upstream="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    ahead="$(git -C "$REPO_ROOT" rev-list --count "$upstream"..HEAD 2>/dev/null || printf 'unknown')"
    behind="$(git -C "$REPO_ROOT" rev-list --count HEAD.."$upstream" 2>/dev/null || printf 'unknown')"
    say "Tracking   : ${GREEN}$upstream${NC} (local refs: ahead=$ahead behind=$behind)"
  else
    warn "no upstream tracking branch configured"
  fi

  check_local_config_templates
  check_npm_status
  check_until_done_runtime_queue_status
  report_check "$current_version" "$local_short" "$([ -n "$dirty" ] && printf true || printf false)"

  say ""
  say "${CYAN}--- planned update command ---${NC}"
  say "  git -C $REPO_ROOT pull --ff-only $REMOTE $BRANCH"
  say "  sync missing local config templates"
  if [ "$RUN_CONFIGURE" = true ]; then
    say "  migrate/normalize local config with pi67-configure.sh --no-prompt --no-doctor"
  else
    say "  skip local config migration (--no-configure)"
  fi
  say "  sync shared skills into $SHARED_SKILLS_DIR"
  if [ "$RUN_NPM" = true ]; then
    say "  sync npm dependencies when package.json differs"
    say "  apply pi-until-done runtime queue/progress compatibility patch when needed"
  else
    say "  skip npm sync (--no-npm)"
    say "  still check/apply pi-until-done runtime queue/progress compatibility patch against existing package"
  fi
  if [ "$RUN_DOCTOR" = true ]; then
    say "  run doctor"
  else
    say "  skip doctor (--no-doctor)"
  fi
  if [ "$RUN_REPORT" = true ]; then
    say "  overwrite $PI_AGENT_DIR/pi67-report.json"
  else
    say "  skip report (--no-report)"
  fi

  say ""
  pass "check-only completed without writing files"
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
  local -a dirty_tracked_paths=()
  local -a unsafe_dirty_paths=()
  local line rel
  current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [ "$current_branch" = "HEAD" ] && [ -z "$BRANCH" ]; then
    fail "detached HEAD; pass --branch explicitly"
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH="$current_branch"
  fi

  dirty="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "${line:0:2}" in
      "??") continue ;;
    esac
    rel="$(repo_status_path "$line")"
    dirty_tracked_paths+=("$rel")
    if ! is_preserved_runtime_file "$rel"; then
      unsafe_dirty_paths+=("$rel")
    fi
  done < <(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=no)

  if [ "${#dirty_tracked_paths[@]}" -gt 0 ] && [ "$ALLOW_DIRTY" != true ]; then
    if [ "${#unsafe_dirty_paths[@]}" -gt 0 ]; then
      printf '%s\n' "$dirty" >&2
      fail "repo has non-runtime local changes; commit/stash them or rerun with --allow-dirty"
    fi
    backup_and_clear_preserved_runtime_edits "${dirty_tracked_paths[@]}"
  elif [ -n "$dirty" ] && [ "$ALLOW_DIRTY" = true ]; then
    warn "repo has local changes; proceeding because --allow-dirty was provided"
  elif [ -n "$dirty" ]; then
    warn "repo has only untracked local files; update will proceed unless Git reports a path collision"
  fi

  before="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  old_version="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"

  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} git -C $REPO_ROOT pull --ff-only $REMOTE $BRANCH"
    pass "current revision: $before"
    return
  fi

  if ! git -C "$REPO_ROOT" pull --ff-only "$REMOTE" "$BRANCH"; then
    restore_preserved_runtime_edits
    fail "git pull failed"
  fi
  restore_preserved_runtime_edits
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

INSTALL_MODE="$(detect_install_mode)"

say ""
say "${CYAN}pi-67 updater${NC}"
say "Repository : $REPO_ROOT"
say "Agent dir  : $PI_AGENT_DIR"
say "Mode       : $INSTALL_MODE"
say "Remote     : $REMOTE"
if [ -n "$BRANCH" ]; then
  say "Branch     : $BRANCH"
fi
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi
if [ "$CHECK_ONLY" = true ]; then
  say "Check only : ${YELLOW}yes${NC}"
fi

if [ "$CHECK_ONLY" = true ]; then
  check_update_plan
  exit 0
fi

update_repo
sync_local_config_templates
run_configure
sync_shared_skills
retire_legacy_agent_skills
sync_npm
patch_until_done_runtime_queue
run_doctor
write_report

say ""
say "${GREEN}pi-67 update finished${NC}"
