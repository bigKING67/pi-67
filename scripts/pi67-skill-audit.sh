#!/usr/bin/env bash
set -euo pipefail

# Compare pi-67 tracked skills with optional legacy manifests and local skill roots.
# The command is read-only unless --output is provided.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
OUTPUT_FORMAT="text"
OUTPUT=""
LEGACY_NAMES=""
LEGACY_LINKS=""
SKILL_ROOTS=()

usage() {
  cat <<'USAGE'
pi67-skill-audit compares tracked pi-67 skills with legacy manifests.

Usage:
  scripts/pi67-skill-audit.sh [options]

Options:
      --repo-root DIR      pi-67 checkout. Defaults to parent of this script.
      --agent-dir DIR      Pi agent dir. Defaults to ~/.pi/agent.
      --legacy-names FILE  Optional newline-delimited legacy skill names.
      --legacy-links FILE  Optional legacy symlink manifest: "name -> target".
      --skill-root DIR     Optional external skill root to compare. Repeatable.
      --output FILE        Write output to FILE instead of stdout.
      --json               Emit machine-readable JSON.
  -h, --help               Show this help.

Examples:
  scripts/pi67-skill-audit.sh
  scripts/pi67-skill-audit.sh --json --output ~/.pi/agent/pi67-skill-audit.json
  scripts/pi67-skill-audit.sh --legacy-names /path/current-skills.txt --legacy-links /path/current-skill-symlinks.txt
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
    --legacy-names)
      LEGACY_NAMES="${2:?--legacy-names requires a file}"
      shift 2
      ;;
    --legacy-links)
      LEGACY_LINKS="${2:?--legacy-links requires a file}"
      shift 2
      ;;
    --skill-root)
      SKILL_ROOTS+=("${2:?--skill-root requires a directory}")
      shift 2
      ;;
    --output)
      OUTPUT="${2:?--output requires a file}"
      shift 2
      ;;
    --json)
      OUTPUT_FORMAT="json"
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

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-skill-audit" >&2
  exit 1
fi

if [ "${#SKILL_ROOTS[@]}" -eq 0 ]; then
  if [ -d "$HOME/.agents/skills" ]; then
    SKILL_ROOTS+=("$HOME/.agents/skills")
  fi
fi

if [ -n "$OUTPUT" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
fi

TMP_OUTPUT=""
if [ -n "$OUTPUT" ]; then
  TMP_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/.pi67-skill-audit.XXXXXX.tmp")"
  trap 'rm -f "$TMP_OUTPUT"' EXIT
else
  TMP_OUTPUT="/dev/stdout"
fi

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$OUTPUT_FORMAT" "$LEGACY_NAMES" "$LEGACY_LINKS" "${SKILL_ROOTS[@]}" > "$TMP_OUTPUT" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const [, , repoRoot, agentDir, outputFormat, legacyNamesFile, legacyLinksFile, ...skillRoots] = process.argv;

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function parseNames(file) {
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function parseLinks(file) {
  const links = {};
  if (!file) return links;
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^(.+?)\s+->\s+(.+)$/);
      if (!match) continue;
      links[match[1].trim()] = match[2].trim();
    }
  } catch {
    return links;
  }
  return links;
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function displayPath(value) {
  if (!value) return value;
  const home = os.homedir();
  return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function legacyEntry(name, links) {
  const target = links[name] || null;
  const resolvedTarget = target ? path.resolve(path.join(agentDir, "skills"), target) : null;
  const targetExists = resolvedTarget ? fs.existsSync(resolvedTarget) : false;
  const skillMdExists = resolvedTarget ? fs.existsSync(path.join(resolvedTarget, "SKILL.md")) : false;
  let classification = "legacy_only_no_link";
  let recommendation = "review manifest source before restoring";

  if (target) {
    if (skillMdExists) {
      classification = "review_external_skill";
      recommendation = "review for public inclusion or personal overlay";
    } else {
      classification = "stale_broken_link";
      recommendation = "do not restore automatically; source skill is missing";
    }
  }

  return {
    name,
    target,
    resolvedTarget: displayPath(resolvedTarget),
    targetExists,
    skillMdExists,
    classification,
    recommendation,
  };
}

function skillRootEntry(root, repoSkills) {
  const names = readDirNames(root).filter((name) => fs.existsSync(path.join(root, name, "SKILL.md")));
  const repoSet = new Set(repoSkills);
  const externalOnly = names.filter((name) => !repoSet.has(name));
  return {
    root: displayPath(root),
    count: names.length,
    names,
    externalOnly,
    externalOnlyCount: externalOnly.length,
  };
}

const repoSkills = readDirNames(path.join(repoRoot, "skills"));
const legacyNames = parseNames(legacyNamesFile);
const legacyLinks = parseLinks(legacyLinksFile);
const commonLegacy = legacyNames.length ? intersection(legacyNames, repoSkills) : [];
const legacyOnly = legacyNames.length ? difference(legacyNames, repoSkills).map((name) => legacyEntry(name, legacyLinks)) : [];
const repoOnlyComparedToLegacy = legacyNames.length ? difference(repoSkills, legacyNames) : [];
const roots = skillRoots.map((root) => skillRootEntry(root, repoSkills));

const report = {
  schemaVersion: 1,
  schemaId: "pi67-skill-audit/v1",
  generatedAt: new Date().toISOString(),
  repository: {
    root: displayPath(repoRoot),
    skillsDir: displayPath(path.join(repoRoot, "skills")),
    skillCount: repoSkills.length,
    skills: repoSkills,
  },
  legacy: {
    namesFile: displayPath(legacyNamesFile || null),
    linksFile: displayPath(legacyLinksFile || null),
    skillCount: legacyNames.length,
    commonCount: commonLegacy.length,
    repoOnlyCount: repoOnlyComparedToLegacy.length,
    legacyOnlyCount: legacyOnly.length,
    common: commonLegacy,
    repoOnly: repoOnlyComparedToLegacy,
    legacyOnly,
  },
  externalSkillRoots: roots,
};

function printList(title, values) {
  console.log(title);
  if (!values.length) {
    console.log("  - none");
    return;
  }
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function printText(data) {
  console.log("");
  console.log("pi-67 skill audit");
  console.log(`Repository skills : ${data.repository.skillCount}`);
  if (data.legacy.skillCount) {
    console.log(`Legacy skills     : ${data.legacy.skillCount}`);
    console.log(`Common            : ${data.legacy.commonCount}`);
    console.log(`Legacy only       : ${data.legacy.legacyOnlyCount}`);
    console.log(`Repo only         : ${data.legacy.repoOnlyCount}`);
  } else {
    console.log("Legacy skills     : not provided");
  }
  console.log("");
  printList("--- repo skills ---", data.repository.skills);

  if (data.legacy.skillCount) {
    console.log("");
    printList("--- repo only compared to legacy ---", data.legacy.repoOnly);
    console.log("");
    console.log("--- legacy only compared to repo ---");
    if (!data.legacy.legacyOnly.length) {
      console.log("  - none");
    } else {
      for (const entry of data.legacy.legacyOnly) {
        const target = entry.target ? ` target=${entry.target}` : "";
        console.log(`  - ${entry.name}: ${entry.classification}; ${entry.recommendation}; targetExists=${entry.targetExists}; skillMdExists=${entry.skillMdExists}${target}`);
      }
    }
  }

  for (const root of data.externalSkillRoots) {
    console.log("");
    console.log(`--- external skill root: ${root.root} ---`);
    console.log(`  skills: ${root.count}`);
    printList("  external only:", root.externalOnly);
  }
}

if (outputFormat === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}
NODE

if [ -n "$OUTPUT" ]; then
  mv "$TMP_OUTPUT" "$OUTPUT"
  trap - EXIT
  echo "pi67 skill audit written: $OUTPUT"
fi
