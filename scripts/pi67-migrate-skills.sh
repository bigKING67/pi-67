#!/usr/bin/env bash
set -euo pipefail

# Move legacy Pi skill roots into the shared ~/.agents/skills registry.
# The command is dry-run by default and never overwrites conflicting skills.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
BACKUP_DIR="${BACKUP_DIR:-$PI_AGENT_DIR/backup-$(date +%Y%m%d-%H%M%S)/skills-migration}"
APPLY=false
YES=false
OUTPUT_FORMAT="text"

usage() {
  cat <<'USAGE'
pi67-migrate-skills moves legacy active Pi skill roots into ~/.agents/skills.

Usage:
  scripts/pi67-migrate-skills.sh [options]

Options:
      --agent-dir DIR   Pi agent dir. Defaults to ~/.pi/agent.
      --skills-dir DIR  Canonical shared skill root. Defaults to ~/.agents/skills.
      --backup-dir DIR  Backup directory for retired roots.
      --dry-run         Preview actions. This is the default.
      --apply           Perform safe copies and move legacy roots into backup.
  -y, --yes             Required with --apply.
      --json            Emit machine-readable JSON.
  -h, --help            Show this help.

This command scans:
  ~/.pi/agent/skills
  ~/.pi/agent/git/github.com/bigKING67/design-craft/skills
  ~/.pi/agent/git/github.com/bigKING67/browser67/skills

Conflict policy:
  - missing canonical skill: copy into --skills-dir when applying
  - identical canonical skill: keep canonical copy
  - different canonical skill: stop; never overwrite
  - migrated legacy roots: move into --backup-dir, never delete
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir)
      PI_AGENT_DIR="${2:?--agent-dir requires a path}"
      if [ -z "${BACKUP_DIR_USER_SET:-}" ]; then
        BACKUP_DIR="$PI_AGENT_DIR/backup-$(date +%Y%m%d-%H%M%S)/skills-migration"
      fi
      shift 2
      ;;
    --skills-dir)
      SHARED_SKILLS_DIR="${2:?--skills-dir requires a path}"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a path}"
      BACKUP_DIR_USER_SET=true
      shift 2
      ;;
    --dry-run)
      APPLY=false
      shift
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    -y|--yes)
      YES=true
      shift
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

if [ "$APPLY" = true ] && [ "$YES" != true ]; then
  echo "--apply requires --yes" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-migrate-skills" >&2
  exit 1
fi

node - "$PI_AGENT_DIR" "$SHARED_SKILLS_DIR" "$BACKUP_DIR" "$APPLY" "$OUTPUT_FORMAT" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const [, , agentDir, sharedSkillsDir, backupDir, applyArg, outputFormat] = process.argv;
const apply = applyArg === "true";

function displayPath(value) {
  if (!value) return value;
  const home = os.homedir();
  const normalized = path.resolve(value);
  return normalized === home ? "~" : normalized.startsWith(`${home}${path.sep}`) ? `~${normalized.slice(home.length)}` : normalized;
}

function existsOrLink(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function readSkillDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

function collectFileHashes(dir, base = dir, output = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFileHashes(full, base, output);
    } else if (stat.isFile()) {
      const relative = path.relative(base, full).split(path.sep).join("/");
      const fileHash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      output.push(`${relative}\0${fileHash}`);
    }
  }
  return output;
}

function skillFingerprint(dir) {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  const hash = crypto.createHash("sha256");
  for (const item of collectFileHashes(dir)) {
    hash.update(item);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function uniqueBackupPath(root) {
  const relative = path.relative(agentDir, root);
  const safeName = relative && !relative.startsWith("..")
    ? relative.split(path.sep).join("__")
    : path.basename(root);
  let candidate = path.join(backupDir, safeName || "legacy-skills");
  let index = 1;
  while (existsOrLink(candidate)) {
    candidate = path.join(backupDir, `${safeName || "legacy-skills"}.${index}`);
    index += 1;
  }
  return candidate;
}

function copySkill(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, errorOnExist: true });
}

function moveRoot(root, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(root, dest);
}

const legacyRoots = [
  {
    kind: "legacy-agent-skills",
    root: path.join(agentDir, "skills"),
  },
  {
    kind: "package-cache-design-craft",
    root: path.join(agentDir, "git", "github.com", "bigKING67", "design-craft", "skills"),
  },
  {
    kind: "package-cache-browser67",
    root: path.join(agentDir, "git", "github.com", "bigKING67", "browser67", "skills"),
  },
];

const report = {
  schemaVersion: 1,
  schemaId: "pi67-skill-migration/v1",
  generatedAt: new Date().toISOString(),
  mode: apply ? "apply" : "dry-run",
  agentDir: displayPath(agentDir),
  sharedSkillsDir: displayPath(sharedSkillsDir),
  backupDir: displayPath(backupDir),
  roots: [],
  actions: [],
  counts: {
    rootsFound: 0,
    skillsScanned: 0,
    missingCanonical: 0,
    identical: 0,
    conflicts: 0,
    rootsToBackup: 0,
    copied: 0,
    backedUpRoots: 0,
  },
  result: "NOOP",
};

for (const item of legacyRoots) {
  const rootExists = existsOrLink(item.root);
  const skills = rootExists ? readSkillDirs(item.root) : [];
  const rootEntry = {
    kind: item.kind,
    root: displayPath(item.root),
    exists: rootExists,
    skillCount: skills.length,
    skills: [],
    backupTarget: null,
    willBackupRoot: false,
  };

  if (rootExists) report.counts.rootsFound += 1;

  let rootHasConflict = false;
  for (const skillDir of skills) {
    const name = path.basename(skillDir);
    const canonical = path.join(sharedSkillsDir, name);
    const canonicalExists = fs.existsSync(path.join(canonical, "SKILL.md"));
    const sourceHash = skillFingerprint(skillDir);
    const canonicalHash = canonicalExists ? skillFingerprint(canonical) : "missing";
    let status = "missing-canonical";

    report.counts.skillsScanned += 1;
    if (!canonicalExists) {
      report.counts.missingCanonical += 1;
      report.actions.push({
        type: "copy-skill",
        name,
        source: displayPath(skillDir),
        destination: displayPath(canonical),
      });
    } else if (sourceHash === canonicalHash) {
      status = "identical";
      report.counts.identical += 1;
    } else {
      status = "conflict";
      rootHasConflict = true;
      report.counts.conflicts += 1;
    }

    rootEntry.skills.push({
      name,
      status,
      source: displayPath(skillDir),
      canonical: displayPath(canonical),
      sourceHash,
      canonicalHash,
    });
  }

  if (rootExists && skills.length > 0 && !rootHasConflict) {
    const backupTarget = uniqueBackupPath(item.root);
    rootEntry.willBackupRoot = true;
    rootEntry.backupTarget = displayPath(backupTarget);
    report.counts.rootsToBackup += 1;
    report.actions.push({
      type: "backup-root",
      kind: item.kind,
      source: displayPath(item.root),
      destination: displayPath(backupTarget),
    });
  }

  report.roots.push(rootEntry);
}

if (report.counts.conflicts > 0) {
  report.result = "NEEDS_REVIEW";
} else if (report.actions.length > 0) {
  report.result = apply ? "APPLIED" : "READY_TO_APPLY";
} else {
  report.result = "NOOP";
}

if (apply && report.counts.conflicts > 0) {
  if (outputFormat === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
    console.error("");
    console.error("Refusing to apply because at least one canonical skill differs. Resolve conflicts manually first.");
  }
  process.exit(1);
}

if (apply && report.actions.length > 0) {
  fs.mkdirSync(sharedSkillsDir, { recursive: true });
  for (const action of report.actions.filter((entry) => entry.type === "copy-skill")) {
    const src = action.source.startsWith("~") ? action.source.replace(/^~/, os.homedir()) : action.source;
    const dest = action.destination.startsWith("~") ? action.destination.replace(/^~/, os.homedir()) : action.destination;
    copySkill(src, dest);
    report.counts.copied += 1;
  }

  const backedUp = new Set();
  for (const root of report.roots.filter((entry) => entry.willBackupRoot)) {
    const source = root.root.startsWith("~") ? root.root.replace(/^~/, os.homedir()) : root.root;
    const destination = root.backupTarget.startsWith("~") ? root.backupTarget.replace(/^~/, os.homedir()) : root.backupTarget;
    if (backedUp.has(source) || !existsOrLink(source)) continue;
    moveRoot(source, destination);
    backedUp.add(source);
    report.counts.backedUpRoots += 1;
  }
}

if (outputFormat === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}

function printText(data) {
  console.log("");
  console.log("pi-67 skill migration");
  console.log(`Mode       : ${data.mode}`);
  console.log(`Agent dir  : ${data.agentDir}`);
  console.log(`Skills dir : ${data.sharedSkillsDir}`);
  console.log(`Backup dir : ${data.backupDir}`);
  console.log("");

  if (fs.existsSync(sharedSkillsDir)) {
    console.log(`  PASS canonical skill root available: ${data.sharedSkillsDir}`);
  } else if (data.mode === "dry-run") {
    console.log(`  DRY-RUN create canonical skill root: ${data.sharedSkillsDir}`);
  }

  for (const root of data.roots) {
    if (!root.exists) continue;
    console.log(`  INFO legacy root found: ${root.root}`);
    if (root.skillCount === 0) {
      console.log("  INFO no valid SKILL.md entries under this root");
    }
    for (const skill of root.skills) {
      if (skill.status === "identical") {
        console.log(`  PASS identical skill: ${skill.name}`);
      } else if (skill.status === "missing-canonical") {
        const prefix = data.mode === "dry-run" ? "DRY-RUN" : "PASS";
        console.log(`  ${prefix} copy missing skill: ${skill.name} -> ${skill.canonical}`);
      } else if (skill.status === "conflict") {
        console.log(`  WARN conflict skill: ${skill.name}`);
        console.log(`       legacy   hash: ${skill.sourceHash}`);
        console.log(`       canonical hash: ${skill.canonicalHash}`);
      }
    }
    if (root.willBackupRoot) {
      const prefix = data.mode === "dry-run" ? "DRY-RUN" : "PASS";
      console.log(`  ${prefix} move legacy root to backup: ${root.root} -> ${root.backupTarget}`);
    } else if (root.skillCount > 0) {
      console.log("  WARN legacy root preserved because conflicts require review");
    }
  }

  if (data.counts.rootsFound === 0) {
    console.log("  PASS no legacy active skill roots found");
  }

  console.log("");
  console.log("Summary");
  console.log(`  roots found       : ${data.counts.rootsFound}`);
  console.log(`  skills scanned    : ${data.counts.skillsScanned}`);
  console.log(`  missing canonical : ${data.counts.missingCanonical}`);
  console.log(`  identical         : ${data.counts.identical}`);
  console.log(`  conflicts         : ${data.counts.conflicts}`);
  if (data.mode === "apply") {
    console.log(`  copied            : ${data.counts.copied}`);
    console.log(`  backed up roots   : ${data.counts.backedUpRoots}`);
  }
  console.log(`Result: ${data.result}`);
}
NODE
