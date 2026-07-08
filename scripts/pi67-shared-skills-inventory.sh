#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="${HOME:-}/.agents/skills"
OUTPUT_JSON=false
STRICT=false

usage() {
  cat <<'USAGE'
pi67-shared-skills-inventory compares pi-67 bundled shared skills with the
machine's shared skill root. It is read-only and never overwrites global skills.

Usage:
  scripts/pi67-shared-skills-inventory.sh [options]

Options:
      --repo-root DIR   Repository root. Defaults to this checkout.
      --skills-dir DIR  Shared skill root. Defaults to ~/.agents/skills.
      --strict          Exit non-zero when bundled skills are missing or differ.
      --json            Print machine-readable JSON.
  -h, --help            Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:-}"
      shift 2
      ;;
    --skills-dir)
      SKILLS_DIR="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT=true
      shift
      ;;
    --json)
      OUTPUT_JSON=true
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

node - "$REPO_ROOT" "$SKILLS_DIR" "$OUTPUT_JSON" "$STRICT" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [, , repoRoot, sharedSkillsDir, outputJsonRaw, strictRaw] = process.argv;
const outputJson = outputJsonRaw === "true";
const strict = strictRaw === "true";
const sourceDir = path.join(repoRoot, "shared-skills");

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readSkillNames(dir) {
  if (!isDirectory(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right));
}

function fingerprintPath(target, root, hash) {
  const stat = fs.lstatSync(target);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (stat.isSymbolicLink()) {
    hash.update(`L ${relative}\0${fs.readlinkSync(target)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`D ${relative}\0`);
    for (const name of fs.readdirSync(target).sort((left, right) => left.localeCompare(right))) {
      fingerprintPath(path.join(target, name), root, hash);
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`F ${relative}\0${stat.mode & 0o777}\0`);
    hash.update(fs.readFileSync(target));
    hash.update("\0");
    return;
  }
  hash.update(`O ${relative}\0${stat.mode}\0`);
}

function skillDirFingerprint(dir) {
  if (!isDirectory(dir)) return null;
  const hash = crypto.createHash("sha256");
  fingerprintPath(dir, dir, hash);
  return hash.digest("hex");
}

function skillRecord(name, status, extra = {}) {
  const sourcePath = path.join(sourceDir, name);
  const installedPath = path.join(sharedSkillsDir, name);
  const sourceExists = fs.existsSync(path.join(sourcePath, "SKILL.md"));
  const installedExists = fs.existsSync(path.join(installedPath, "SKILL.md"));
  return {
    name,
    sourceExists,
    installedExists,
    status,
    decision: extra.decision || null,
    sourceSha256: sourceExists ? skillDirFingerprint(sourcePath) : null,
    installedSha256: installedExists ? skillDirFingerprint(installedPath) : null,
    reason: extra.reason || null,
  };
}

const sourceSkills = readSkillNames(sourceDir);
const installedSkills = readSkillNames(sharedSkillsDir);
const installedSet = new Set(installedSkills);
const sourceSet = new Set(sourceSkills);
const skills = [];

for (const name of sourceSkills) {
  if (!installedSet.has(name)) {
    skills.push(skillRecord(name, "missing_installed", {
      decision: "install_from_pi67_source",
      reason: "pi-67 bundled shared skill is missing from the global shared skill root",
    }));
    continue;
  }
  const record = skillRecord(name, "matching", {
    decision: "keep_global",
    reason: "global shared skill matches pi-67 source",
  });
  if (record.sourceSha256 !== record.installedSha256) {
    record.status = "global_differs";
    record.reason = "global shared skill differs from pi-67 source; pi-67 preserves it as user-modified by default";
  }
  skills.push(record);
}

for (const name of installedSkills.filter((item) => !sourceSet.has(item))) {
  skills.push(skillRecord(name, "extra_global", {
    decision: "keep_global",
    reason: "global shared skill is outside the pi-67 bundled source set",
  }));
}

const summary = {
  source: sourceSkills.length,
  installed: installedSkills.length,
  missing: skills.filter((skill) => skill.status === "missing_installed").length,
  matching: skills.filter((skill) => skill.status === "matching").length,
  differing: skills.filter((skill) => skill.status === "global_differs").length,
  extra: skills.filter((skill) => skill.status === "extra_global").length,
};

let result = "OK";
if (summary.missing > 0 || (strict && summary.differing > 0)) {
  result = "ACTION_REQUIRED";
} else if (summary.differing > 0 || summary.extra > 0) {
  result = "OK_WITH_DRIFT";
}

const report = {
  schemaVersion: 1,
  schemaId: "pi67-shared-skills-inventory/v1",
  generatedAt: new Date().toISOString(),
  sourceDir,
  sharedSkillsDir,
  strict,
  summary,
  skills,
  result,
};

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log("pi-67 shared skills inventory");
  console.log(`Source    : ${sourceDir}`);
  console.log(`Installed : ${sharedSkillsDir}`);
  console.log(`Result    : ${result}`);
  console.log(
    `Summary   : source=${summary.source} installed=${summary.installed} ` +
      `matching=${summary.matching} preserved_user_modified=${summary.differing} missing=${summary.missing} extra=${summary.extra}`,
  );
  const differing = skills.filter((skill) => skill.status === "global_differs").map((skill) => skill.name);
  const missing = skills.filter((skill) => skill.status === "missing_installed").map((skill) => skill.name);
  const extra = skills.filter((skill) => skill.status === "extra_global").map((skill) => skill.name);
  if (differing.length > 0) {
    console.log(`Preserved user-modified : ${differing.join(", ")}`);
    console.log("Decision  : preserving existing global skills by default");
  }
  if (missing.length > 0) console.log(`Missing   : ${missing.join(", ")}`);
  if (extra.length > 0) console.log(`Extra     : ${extra.join(", ")}`);
  console.log("");
  console.log("Use --json for hashes and per-skill details.");
}

process.exit(result === "ACTION_REQUIRED" ? 1 : 0);
NODE
