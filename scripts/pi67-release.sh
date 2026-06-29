#!/usr/bin/env bash
set -euo pipefail

# Create a guarded pi-67 release tag and GitHub Release from VERSION/CHANGELOG.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
YES=false
RUN_SMOKE=true
ALLOW_DIRTY=false
PUSH_TAG=true
CREATE_GITHUB_RELEASE=true
REPLACE_EXISTING=false
REMOTE="origin"
GH_REPO=""

usage() {
  cat <<'USAGE'
pi67-release creates a guarded pi-67 release from VERSION and CHANGELOG.md.

Usage:
  scripts/pi67-release.sh [options]

Options:
      --repo-root DIR        pi-67 checkout. Defaults to parent of this script.
      --remote NAME          Git remote. Defaults to origin.
      --github-repo OWNER/REPO
                             GitHub repo for `gh release`.
      --dry-run              Print plan and generated notes without writing tags/releases.
      --yes                  Required for actual tag/release creation.
      --no-smoke             Skip scripts/pi67-smoke.sh --ci.
      --allow-dirty          Allow an actual release from a dirty worktree. Dry-run only warns.
      --no-push              Create only a local tag; skip git push.
      --no-github-release    Skip `gh release create`.
      --replace-existing     Replace the same VERSION tag/release. Requires --yes.
  -h, --help                 Show this help.

Duplicate policy:
  Normal releases never delete historical versions and never create duplicate
  same-version releases. If v$(cat VERSION) already exists, the script stops.
  Use --replace-existing --yes only to replace the same current VERSION tag/release.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:?--remote requires a name}"
      shift 2
      ;;
    --github-repo)
      GH_REPO="${2:?--github-repo requires OWNER/REPO}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --yes)
      YES=true
      shift
      ;;
    --no-smoke)
      RUN_SMOKE=false
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=true
      shift
      ;;
    --no-push)
      PUSH_TAG=false
      shift
      ;;
    --no-github-release)
      CREATE_GITHUB_RELEASE=false
      shift
      ;;
    --replace-existing)
      REPLACE_EXISTING=true
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

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

run_or_show() {
  if [ "$DRY_RUN" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} $*"
  else
    "$@"
  fi
}

gh_args() {
  if [ -n "$GH_REPO" ]; then
    printf '%s\n' "--repo" "$GH_REPO"
  fi
}

version() {
  tr -d '[:space:]' < "$REPO_ROOT/VERSION"
}

make_notes() {
  local notes_file="$1"
  node - "$REPO_ROOT" "$VERSION" > "$notes_file" <<'NODE'
const fs = require("fs");
const path = require("path");

const [, , repoRoot, version] = process.argv;
const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  throw new Error(`CHANGELOG.md missing entry for ${version}`);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith("## [")) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
console.log(`# pi-67 v${version}`);
console.log("");
console.log("## What changed");
console.log("");
console.log(body || "- See CHANGELOG.md.");
console.log("");
console.log("## Install");
console.log("");
console.log("```bash");
console.log("git clone https://github.com/bigKING67/pi-67.git");
console.log("cd pi-67");
console.log("./install.sh");
console.log("```");
console.log("");
console.log("## Update");
console.log("");
console.log("```bash");
console.log("bash ~/.pi/agent/scripts/pi67-update.sh");
console.log("```");
console.log("");
console.log("Older installs without the updater:");
console.log("");
console.log("```bash");
console.log("cd /path/to/pi-67");
console.log("git pull --ff-only");
console.log("bash scripts/pi67-update.sh");
console.log("```");
console.log("");
console.log("## Verification");
console.log("");
console.log("- `bash scripts/pi67-release-check.sh`");
console.log("- `bash scripts/pi67-smoke.sh --ci`");
console.log("- GitHub Actions CI should pass on the release commit.");
NODE
}

delete_existing_same_version() {
  local tag="$1"

  if [ "$REPLACE_EXISTING" != true ]; then
    return
  fi

  if [ "$YES" != true ]; then
    fail "--replace-existing requires --yes"
  fi

  warn "replacing existing same-version release/tag: $tag"

  if [ "$CREATE_GITHUB_RELEASE" = true ] && command_exists gh; then
    if gh release view "$tag" $(gh_args) >/dev/null 2>&1; then
      run_or_show gh release delete "$tag" --cleanup-tag --yes $(gh_args)
    fi
  fi

  if git -C "$REPO_ROOT" tag --list "$tag" | grep -qx "$tag"; then
    run_or_show git -C "$REPO_ROOT" tag -d "$tag"
  fi

  if [ "$PUSH_TAG" = true ] && git -C "$REPO_ROOT" ls-remote --exit-code --tags "$REMOTE" "refs/tags/$tag" >/dev/null 2>&1; then
    run_or_show git -C "$REPO_ROOT" push "$REMOTE" ":refs/tags/$tag"
  fi
}

say ""
say "${CYAN}pi-67 release automation${NC}"
say "Repository : $REPO_ROOT"

if ! command_exists git; then
  fail "git not found"
fi

if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "not a git checkout: $REPO_ROOT"
fi

if [ "$CREATE_GITHUB_RELEASE" = true ] && [ "$DRY_RUN" != true ] && ! command_exists gh; then
  fail "gh not found; rerun with --no-github-release or install GitHub CLI"
fi

if [ "$CREATE_GITHUB_RELEASE" = true ] && [ "$PUSH_TAG" != true ]; then
  fail "--no-push cannot be combined with GitHub release creation"
fi

VERSION="$(version)"
TAG="v$VERSION"
NOTES_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi67-release-notes.XXXXXX")"
NOTES_FILE="$NOTES_DIR/release-notes.md"
trap 'rm -rf "$NOTES_DIR"' EXIT
make_notes "$NOTES_FILE"

say "Version    : ${GREEN}$VERSION${NC}"
say "Tag        : ${GREEN}$TAG${NC}"
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi

dirty="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
if [ -n "$dirty" ] && [ "$DRY_RUN" = true ]; then
  warn "worktree is dirty; dry-run will continue without writing"
elif [ -n "$dirty" ] && [ "$ALLOW_DIRTY" != true ]; then
  say "$dirty" >&2
  fail "worktree has local changes; commit/stash first or rerun with --allow-dirty"
fi
if [ -n "$dirty" ] && [ "$DRY_RUN" != true ]; then
  warn "worktree is dirty; proceeding because --allow-dirty was provided"
fi

say ""
say "${CYAN}--- release checks ---${NC}"
bash "$REPO_ROOT/scripts/pi67-release-check.sh"
pass "release metadata check passed"

if [ "$RUN_SMOKE" = true ]; then
  bash "$REPO_ROOT/scripts/pi67-smoke.sh" --ci
  pass "smoke check passed"
else
  warn "smoke check skipped by --no-smoke"
fi

local_tag_exists=false
remote_tag_exists=false
github_release_exists=false

if git -C "$REPO_ROOT" tag --list "$TAG" | grep -qx "$TAG"; then
  local_tag_exists=true
fi
if git -C "$REPO_ROOT" ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  remote_tag_exists=true
fi
if [ "$CREATE_GITHUB_RELEASE" = true ] && command_exists gh && gh release view "$TAG" $(gh_args) >/dev/null 2>&1; then
  github_release_exists=true
fi

if [ "$local_tag_exists" = true ] || [ "$remote_tag_exists" = true ] || [ "$github_release_exists" = true ]; then
  if [ "$REPLACE_EXISTING" = true ]; then
    delete_existing_same_version "$TAG"
  elif [ "$DRY_RUN" = true ]; then
    warn "actual release would stop because $TAG already exists"
  else
    fail "$TAG already exists; bump VERSION or use --replace-existing --yes to replace this same version"
  fi
fi

say ""
say "${CYAN}--- release notes preview ---${NC}"
sed -n '1,120p' "$NOTES_FILE"

if [ "$DRY_RUN" = true ]; then
  say ""
  say "${CYAN}--- release plan ---${NC}"
  say "  ${CYAN}DRY-RUN${NC} git tag -a $TAG -m \"pi-67 $VERSION\""
  if [ "$PUSH_TAG" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} git push $REMOTE $TAG"
  fi
  if [ "$CREATE_GITHUB_RELEASE" = true ]; then
    say "  ${CYAN}DRY-RUN${NC} gh release create $TAG --title \"pi-67 $TAG\" --notes-file $NOTES_FILE"
  fi
  say ""
  pass "dry-run completed"
  exit 0
fi

if [ "$YES" != true ]; then
  fail "actual release requires --yes"
fi

say ""
say "${CYAN}--- create release ---${NC}"
git -C "$REPO_ROOT" tag -a "$TAG" -m "pi-67 $VERSION"
pass "created local tag: $TAG"

if [ "$PUSH_TAG" = true ]; then
  git -C "$REPO_ROOT" push "$REMOTE" "$TAG"
  pass "pushed tag: $TAG"
else
  warn "tag push skipped by --no-push"
fi

if [ "$CREATE_GITHUB_RELEASE" = true ]; then
  gh release create "$TAG" --title "pi-67 $TAG" --notes-file "$NOTES_FILE" $(gh_args)
  pass "GitHub Release created: $TAG"
else
  warn "GitHub Release creation skipped by --no-github-release"
fi

say ""
say "${GREEN}pi-67 release finished: $TAG${NC}"
