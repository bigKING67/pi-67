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
NPM_MANAGER_PACKAGE="@bigking67/pi-67"

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
  PI67_RELEASE_FROM_HEAD="$([ "$DRY_RUN" = true ] && printf '0' || printf '1')" \
    node - "$REPO_ROOT" "$VERSION" > "$notes_file" <<'NODE'
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , repoRoot, version] = process.argv;
const changelog = process.env.PI67_RELEASE_FROM_HEAD === "1"
  ? execFileSync("git", ["-C", repoRoot, "show", "HEAD:CHANGELOG.md"], { encoding: "utf8" })
  : fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
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
console.log("Windows after completing docs/windows-fresh-install.md prerequisites:");
console.log("");
console.log("```powershell");
console.log('$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"');
console.log('Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap');
console.log('powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto');
console.log("```");
console.log("");
console.log("macOS/Linux:");
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
console.log("bash ~/.pi/agent/scripts/pi67-status.sh");
console.log("```");
console.log("");
console.log("Older installs without the updater:");
console.log("");
console.log("```bash");
console.log("cd /path/to/pi-67");
console.log("git pull --ff-only");
console.log("bash scripts/pi67-update.sh");
console.log("bash ~/.pi/agent/scripts/pi67-status.sh");
console.log("```");
console.log("");
console.log("## Verification");
console.log("");
console.log("- `bash scripts/pi67-release-check.sh`");
console.log("- `bash scripts/pi67-smoke.sh --ci`");
console.log("- GitHub Actions CI should pass on the release commit.");
NODE
}

make_bootstrap_assets() {
  local asset_file="$1"
  local checksum_file="$2"
  local source_file="$REPO_ROOT/scripts/pi67-bootstrap.ps1"

  if [ "$DRY_RUN" = true ]; then
    if [ ! -f "$source_file" ]; then
      fail "Windows bootstrap source is missing: $source_file"
    fi
    cp "$source_file" "$asset_file"
  elif ! git -C "$REPO_ROOT" show "HEAD:scripts/pi67-bootstrap.ps1" > "$asset_file"; then
    fail "Windows bootstrap is not present in the release commit"
  fi
  node - "$asset_file" "$checksum_file" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const [assetFile, checksumFile] = process.argv.slice(2);
const digest = crypto.createHash("sha256").update(fs.readFileSync(assetFile)).digest("hex");
fs.writeFileSync(checksumFile, `${digest}  ${path.basename(assetFile)}\n`, "utf8");
NODE
}

check_npm_manager_release_prerequisite() {
  local exact_target="${NPM_MANAGER_PACKAGE}@${VERSION}"
  local latest_target="${NPM_MANAGER_PACKAGE}@latest"
  local exact_published=""
  local latest_published=""

  if command_exists npm; then
    exact_published="$(npm view "$exact_target" version --json 2>/dev/null || true)"
    exact_published="$(printf '%s' "$exact_published" | tr -d '[:space:]"')"
    latest_published="$(npm view "$latest_target" version --json 2>/dev/null || true)"
    latest_published="$(printf '%s' "$latest_published" | tr -d '[:space:]"')"
  fi

  if [ "$exact_published" = "$VERSION" ] && [ "$latest_published" = "$VERSION" ]; then
    pass "npm manager is published and latest points to it: $exact_target"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    if [ "$exact_published" != "$VERSION" ]; then
      warn "$exact_target is not published yet; an actual GitHub Release will stop before creating a tag"
    fi
    if [ "$latest_published" != "$VERSION" ]; then
      warn "$latest_target resolves to ${latest_published:-unavailable}, expected $VERSION; the bootstrap installs @latest"
    fi
    return
  fi

  if [ "$exact_published" != "$VERSION" ]; then
    fail "publish $exact_target with .github/workflows/npm-publish.yml before creating the GitHub Release"
  fi
  fail "point the npm latest dist-tag at $exact_target before creating the GitHub Release"
}

check_release_head_contract() {
  if [ "$DRY_RUN" = true ]; then
    return
  fi

  if node - "$REPO_ROOT" "$VERSION" <<'NODE'
const { execFileSync } = require("child_process");

const [repoRoot, expectedVersion] = process.argv.slice(2);
const show = (file) => execFileSync("git", ["-C", repoRoot, "show", `HEAD:${file}`], { encoding: "utf8" });
const errors = [];

let version = "";
let rootPackage = {};
let managerPackage = {};
let changelog = "";
try { version = show("VERSION").trim(); } catch { errors.push("VERSION is missing from HEAD"); }
try { rootPackage = JSON.parse(show("package.json")); } catch { errors.push("package.json is missing or invalid in HEAD"); }
try { managerPackage = JSON.parse(show("packages/pi67-cli/package.json")); } catch { errors.push("manager package.json is missing or invalid in HEAD"); }
try { changelog = show("CHANGELOG.md"); } catch { errors.push("CHANGELOG.md is missing from HEAD"); }
try { show("scripts/pi67-bootstrap.ps1"); } catch { errors.push("scripts/pi67-bootstrap.ps1 is missing from HEAD"); }

if (version && version !== expectedVersion) errors.push(`HEAD VERSION is ${version}, expected ${expectedVersion}`);
if (rootPackage.version !== expectedVersion) errors.push(`HEAD root package version is ${rootPackage.version || "missing"}`);
if (managerPackage.version !== expectedVersion) errors.push(`HEAD manager package version is ${managerPackage.version || "missing"}`);
if (changelog && !changelog.split(/\r?\n/).some((line) => line.startsWith(`## [${expectedVersion}]`))) {
  errors.push(`HEAD CHANGELOG.md is missing ${expectedVersion}`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
NODE
  then
    pass "release metadata and bootstrap are committed in HEAD"
  else
    fail "release metadata must be committed before tagging; --allow-dirty does not release uncommitted candidate files"
  fi
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
BOOTSTRAP_ASSET="$NOTES_DIR/pi67-bootstrap.ps1"
BOOTSTRAP_CHECKSUM="$NOTES_DIR/pi67-bootstrap.ps1.sha256"
trap 'rm -rf "$NOTES_DIR"' EXIT

say "Version    : ${GREEN}$VERSION${NC}"
say "Tag        : ${GREEN}$TAG${NC}"
say "Assets     : pi67-bootstrap.ps1, pi67-bootstrap.ps1.sha256"
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

check_release_head_contract
make_notes "$NOTES_FILE"

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

if [ "$CREATE_GITHUB_RELEASE" = true ]; then
  say ""
  say "${CYAN}--- npm bootstrap prerequisite ---${NC}"
  check_npm_manager_release_prerequisite
fi

make_bootstrap_assets "$BOOTSTRAP_ASSET" "$BOOTSTRAP_CHECKSUM"

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
    say "  ${CYAN}DRY-RUN${NC} gh release create $TAG $BOOTSTRAP_ASSET $BOOTSTRAP_CHECKSUM --title \"pi-67 $TAG\" --notes-file $NOTES_FILE"
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
  gh release create "$TAG" "$BOOTSTRAP_ASSET" "$BOOTSTRAP_CHECKSUM" --title "pi-67 $TAG" --notes-file "$NOTES_FILE" $(gh_args)
  pass "GitHub Release created with Windows bootstrap assets: $TAG"
else
  warn "GitHub Release creation skipped by --no-github-release"
fi

say ""
say "${GREEN}pi-67 release finished: $TAG${NC}"
