#!/usr/bin/env bash
set -euo pipefail

# Optional local integration check for external skill repositories.
# It dry-runs pi67-sync-external-skills.sh and summarizes conflicts/invalid repos.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
OUTPUT_FORMAT="text"
STRICT=false
REPOS=()

usage() {
  cat <<'USAGE'
pi67-check-external-skills dry-runs external skill repo integration.

Usage:
  scripts/pi67-check-external-skills.sh --repo DIR [--repo DIR ...] [options]

Options:
      --repo DIR        External repo containing either SKILL.md at repo root
                        or skills/*/SKILL.md. Repeatable.
      --skills-dir DIR  Canonical shared skill root. Defaults to ~/.agents/skills.
      --repo-root DIR   pi-67 repository root. Defaults to this script's parent.
      --dry-run         Accepted for clarity; this command never applies changes.
      --json            Emit combined machine-readable JSON.
      --strict          Return nonzero when repos are invalid or conflicts exist.
  -h, --help            Show this help.

Examples:
  bash scripts/pi67-check-external-skills.sh \
    --repo /path/to/design-craft \
    --repo /path/to/browser67

  bash scripts/pi67-check-external-skills.sh --repo /path/to/commerce-growth-os

  bash scripts/pi67-check-external-skills.sh --repo /path/to/design-craft --json
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPOS+=("${2:?--repo requires a path}")
      shift 2
      ;;
    --skills-dir)
      SHARED_SKILLS_DIR="${2:?--skills-dir requires a path}"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --dry-run)
      shift
      ;;
    --json)
      OUTPUT_FORMAT="json"
      shift
      ;;
    --strict)
      STRICT=true
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

if [ "${#REPOS[@]}" -eq 0 ]; then
  echo "at least one --repo is required" >&2
  usage >&2
  exit 2
fi

if [ ! -f "$REPO_ROOT/scripts/pi67-sync-external-skills.sh" ]; then
  echo "missing helper: $REPO_ROOT/scripts/pi67-sync-external-skills.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-check-external-skills" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi67-external-skills-check.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SYNC_JSON="$TMP_DIR/sync.json"
SYNC_ERR="$TMP_DIR/sync.err"
SYNC_ARGS=(--skills-dir "$SHARED_SKILLS_DIR" --dry-run --json)
for repo in "${REPOS[@]}"; do
  SYNC_ARGS+=(--repo "$repo")
done

set +e
"$REPO_ROOT/scripts/pi67-sync-external-skills.sh" "${SYNC_ARGS[@]}" > "$SYNC_JSON" 2> "$SYNC_ERR"
SYNC_STATUS=$?
set -e

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$SYNC_JSON" >/dev/null 2>&1; then
  cat "$SYNC_ERR" >&2
  echo "pi67-sync-external-skills did not emit valid JSON" >&2
  exit 1
fi

node - "$SYNC_JSON" "$OUTPUT_FORMAT" "$STRICT" "$SYNC_STATUS" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const [, , syncFile, outputFormat, strictRaw, syncStatusRaw] = process.argv;
const sync = JSON.parse(fs.readFileSync(syncFile, "utf8"));
const strict = strictRaw === "true";
const syncExitCode = Number(syncStatusRaw);

function display(value) {
  if (!value) return value;
  const home = os.homedir();
  const resolved = value.startsWith("~") ? path.join(home, value.slice(2)) : value;
  return resolved === home ? "~" : resolved.startsWith(`${home}${path.sep}`) ? `~${resolved.slice(home.length)}` : value;
}

const invalidRepos = sync.counts?.invalidRepos || 0;
const conflicts = sync.counts?.conflicts || 0;
const missingCanonical = sync.counts?.missingCanonical || 0;
let result = "NOOP";
if (invalidRepos > 0) {
  result = "INVALID_INPUT";
} else if (conflicts > 0) {
  result = "NEEDS_REVIEW";
} else if (missingCanonical > 0) {
  result = "READY_TO_APPLY";
}

const report = {
  schemaVersion: 1,
  schemaId: "pi67-external-skills-check/v1",
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/pi67-check-external-skills.sh",
  mode: "dry-run",
  strict,
  syncExitCode,
  sharedSkillsDir: sync.sharedSkillsDir,
  result,
  counts: {
    repos: sync.counts?.repos || 0,
    reposWithSkills: sync.counts?.reposWithSkills || 0,
    invalidRepos,
    skillsScanned: sync.counts?.skillsScanned || 0,
    missingCanonical,
    identical: sync.counts?.identical || 0,
    conflicts,
  },
  repositories: sync.repositories || [],
  hints: sync.hints || [],
};

if (outputFormat === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log("pi-67 external skills check");
  console.log("Mode       : dry-run");
  console.log(`Strict     : ${strict ? "yes" : "no"}`);
  console.log(`Skills dir : ${display(report.sharedSkillsDir)}`);
  console.log("");

  for (const repo of report.repositories) {
    if (!repo.exists) {
      console.log(`  WARN repo not found: ${display(repo.repo)}`);
      continue;
    }
    console.log(`  INFO repo: ${display(repo.repo)}`);
    if (repo.error) {
      console.log(`  WARN ${repo.error}: ${display(repo.repo)}`);
      continue;
    }
    for (const skill of repo.skills || []) {
      if (skill.status === "identical") {
        console.log(`  PASS identical skill: ${skill.name}`);
      } else if (skill.status === "missing-canonical") {
        console.log(`  DRY-RUN copy missing skill: ${skill.name} -> ${display(skill.canonical)}`);
      } else if (skill.status === "conflict") {
        console.log(`  WARN conflict skill: ${skill.name}`);
        console.log(`       source    hash: ${skill.sourceHash}`);
        console.log(`       canonical hash: ${skill.canonicalHash}`);
      }
    }
  }

  for (const hint of report.hints) {
    console.log(`  INFO ${hint}`);
  }

  console.log("");
  console.log("Summary");
  console.log(`  repos             : ${report.counts.repos}`);
  console.log(`  repos with skills : ${report.counts.reposWithSkills}`);
  console.log(`  invalid repos     : ${report.counts.invalidRepos}`);
  console.log(`  skills scanned    : ${report.counts.skillsScanned}`);
  console.log(`  missing canonical : ${report.counts.missingCanonical}`);
  console.log(`  identical         : ${report.counts.identical}`);
  console.log(`  conflicts         : ${report.counts.conflicts}`);
  console.log(`Result: ${report.result}`);
}

if (strict && (invalidRepos > 0 || conflicts > 0 || syncExitCode > 1)) {
  process.exit(1);
}
NODE
