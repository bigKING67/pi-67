#!/usr/bin/env bash
set -euo pipefail

# Copy skills from external source repositories into the shared ~/.agents/skills
# registry without making those repositories active Pi package skill roots.

SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.agents/backup-$(date +%Y%m%d-%H%M%S)/external-skills}"
APPLY=false
YES=false
OUTPUT_FORMAT="text"
REPOS=()

usage() {
  cat <<'USAGE'
pi67-sync-external-skills copies repo-owned skills into ~/.agents/skills.

Usage:
  scripts/pi67-sync-external-skills.sh --repo DIR [--repo DIR ...] [options]

Options:
      --repo DIR        External repo containing either SKILL.md at repo root
                        or skills/*/SKILL.md. Repeatable.
      --skills-dir DIR  Canonical shared skill root. Defaults to ~/.agents/skills.
      --backup-dir DIR  Reserved for future explicit replace flows; this command
                        does not overwrite and normally does not write backups.
      --dry-run         Preview actions. This is the default.
      --apply           Copy missing skills.
  -y, --yes             Required with --apply.
      --json            Emit machine-readable JSON.
  -h, --help            Show this help.

Examples:
  bash scripts/pi67-sync-external-skills.sh --repo /path/to/design-craft --dry-run
  bash scripts/pi67-sync-external-skills.sh --repo /path/to/browser67 --apply --yes
  bash scripts/pi67-sync-external-skills.sh --repo /path/to/root-skill-repo --dry-run

Conflict policy:
  - missing canonical skill: copy into --skills-dir when applying
  - identical canonical skill: skip
  - different canonical skill: stop; never overwrite
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
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a path}"
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

if [ "${#REPOS[@]}" -eq 0 ]; then
  echo "at least one --repo is required" >&2
  usage >&2
  exit 2
fi

if [ "$APPLY" = true ] && [ "$YES" != true ]; then
  echo "--apply requires --yes" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-sync-external-skills" >&2
  exit 1
fi

node - "$SHARED_SKILLS_DIR" "$BACKUP_DIR" "$APPLY" "$OUTPUT_FORMAT" "${REPOS[@]}" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const [, , sharedSkillsDir, backupDir, applyArg, outputFormat, ...repos] = process.argv;
const apply = applyArg === "true";

function displayPath(value) {
  if (!value) return value;
  const home = os.homedir();
  const normalized = path.resolve(value);
  return normalized === home ? "~" : normalized.startsWith(`${home}${path.sep}`) ? `~${normalized.slice(home.length)}` : normalized;
}

const IGNORED_SKILL_NAMES = new Set([
  ".git",
  ".DS_Store",
  ".gitignore",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".coverage",
  "coverage",
  "dist",
  "build",
  "node_modules",
  ".venv",
  "venv",
  ".next",
  "out",
  "tmp",
]);

const IGNORED_SKILL_RELATIVE_PATHS = new Set([
  "eval/answers",
]);

function shouldSkipSkillPath(fullPath, baseDir) {
  const relative = path.relative(baseDir, fullPath).split(path.sep).join("/");
  if (!relative) return false;
  if (IGNORED_SKILL_RELATIVE_PATHS.has(relative)) return true;
  const parts = relative.split("/");
  return parts.some((part) => IGNORED_SKILL_NAMES.has(part));
}

function readSkillName(skillDir) {
  const skillFile = path.join(skillDir, "SKILL.md");
  let text = "";
  try {
    text = fs.readFileSync(skillFile, "utf8");
  } catch {
    return path.basename(skillDir);
  }
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const name = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\n#]+)["']?\s*$/m)?.[1]?.trim();
  return name || path.basename(skillDir);
}

function readSkillDirs(repo) {
  const skills = [];

  if (fs.existsSync(path.join(repo, "SKILL.md"))) {
    skills.push({ dir: repo, layout: "repo-root" });
  }

  const root = path.join(repo, "skills");
  try {
    const nested = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")))
      .map((dir) => ({ dir, layout: "skills-dir" }));
    skills.push(...nested);
  } catch {
    // Repos with root-level SKILL.md do not need a skills/ directory.
  }

  return skills.sort((a, b) => readSkillName(a.dir).localeCompare(readSkillName(b.dir)));
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
    if (shouldSkipSkillPath(full, base)) continue;
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

function copySkill(src, dest) {
  if (fs.existsSync(dest)) {
    throw new Error(`destination already exists: ${dest}`);
  }
  fs.mkdirSync(dest, { recursive: true });

  function copyDir(current, base, target) {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (shouldSkipSkillPath(full, base)) continue;
      const out = path.join(target, path.relative(base, full));
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.mkdirSync(out, { recursive: true });
        copyDir(full, base, target);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(full, out);
        fs.chmodSync(out, stat.mode);
      }
    }
  }

  copyDir(src, src, dest);
}

const report = {
  schemaVersion: 1,
  schemaId: "pi67-external-skill-sync/v1",
  generatedAt: new Date().toISOString(),
  mode: apply ? "apply" : "dry-run",
  sharedSkillsDir: displayPath(sharedSkillsDir),
  backupDir: displayPath(backupDir),
  repositories: [],
  actions: [],
  counts: {
    repos: repos.length,
    reposWithSkills: 0,
    invalidRepos: 0,
    skillsScanned: 0,
    missingCanonical: 0,
    identical: 0,
    conflicts: 0,
    copied: 0,
  },
  hints: [],
  result: "NOOP",
};

for (const repo of repos) {
  const repoEntry = {
    repo: displayPath(repo),
    exists: fs.existsSync(repo),
    skillsDir: displayPath(path.join(repo, "skills")),
    sourceLayouts: [],
    skillCount: 0,
    skills: [],
  };

  if (!repoEntry.exists) {
    report.counts.invalidRepos += 1;
    repoEntry.error = "repo not found";
    report.repositories.push(repoEntry);
    continue;
  }

  const skillDirs = readSkillDirs(repo);
  repoEntry.skillCount = skillDirs.length;
  repoEntry.sourceLayouts = [...new Set(skillDirs.map((entry) => entry.layout))].sort();
  if (skillDirs.length === 0) {
    report.counts.invalidRepos += 1;
    repoEntry.error = "no SKILL.md or skills/*/SKILL.md entries found";
    report.repositories.push(repoEntry);
    continue;
  }

  report.counts.reposWithSkills += 1;
  const names = [];
  for (const skill of skillDirs) {
    const skillDir = skill.dir;
    const name = readSkillName(skillDir);
    names.push(name);
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
      report.counts.conflicts += 1;
    }

    repoEntry.skills.push({
      name,
      status,
      sourceLayout: skill.layout,
      source: displayPath(skillDir),
      canonical: displayPath(canonical),
      sourceHash,
      canonicalHash,
    });
  }

  const repoName = path.basename(path.resolve(repo)).toLowerCase();
  if (repoName.includes("browser67") || names.includes("tmwd-browser-mcp") || names.includes("js-reverse")) {
    report.hints.push(`browser67 MCP hint: run scripts/pi67-configure.sh --tmwd-repo ${displayPath(repo)} --no-prompt if this checkout should serve MCP.`);
  }

  report.repositories.push(repoEntry);
}

if (report.counts.invalidRepos > 0) {
  report.result = "INVALID_INPUT";
} else if (report.counts.conflicts > 0) {
  report.result = "NEEDS_REVIEW";
} else if (report.actions.length > 0) {
  report.result = apply ? "APPLIED" : "READY_TO_APPLY";
} else {
  report.result = "NOOP";
}

if (apply && (report.counts.invalidRepos > 0 || report.counts.conflicts > 0)) {
  if (outputFormat === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
    console.error("");
    if (report.counts.invalidRepos > 0) {
      console.error("Refusing to apply because at least one --repo is invalid or has no skills.");
    }
    if (report.counts.conflicts > 0) {
      console.error("Refusing to apply because at least one canonical skill differs. Resolve conflicts manually first.");
    }
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
}

if (outputFormat === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}

if (report.counts.invalidRepos > 0) {
  process.exit(1);
}

function printText(data) {
  console.log("");
  console.log("pi-67 external skill sync");
  console.log(`Mode       : ${data.mode}`);
  console.log(`Skills dir : ${data.sharedSkillsDir}`);
  console.log("");

  if (fs.existsSync(sharedSkillsDir)) {
    console.log(`  PASS canonical skill root available: ${data.sharedSkillsDir}`);
  } else if (data.mode === "dry-run") {
    console.log(`  DRY-RUN create canonical skill root: ${data.sharedSkillsDir}`);
  }

  for (const repo of data.repositories) {
    if (!repo.exists) {
      console.log(`  FAIL repo not found: ${repo.repo}`);
      continue;
    }
    console.log(`  INFO repo: ${repo.repo}`);
    if (repo.error) {
      console.log(`  FAIL ${repo.error}: ${repo.repo}`);
      continue;
    }
    for (const skill of repo.skills) {
      if (skill.status === "identical") {
        console.log(`  PASS identical skill: ${skill.name}`);
      } else if (skill.status === "missing-canonical") {
        const prefix = data.mode === "dry-run" ? "DRY-RUN" : "PASS";
        console.log(`  ${prefix} copy missing skill: ${skill.name} -> ${skill.canonical}`);
      } else if (skill.status === "conflict") {
        console.log(`  WARN conflict skill: ${skill.name}`);
        console.log(`       source    hash: ${skill.sourceHash}`);
        console.log(`       canonical hash: ${skill.canonicalHash}`);
      }
    }
  }

  for (const hint of data.hints) {
    console.log(`  INFO ${hint}`);
  }

  console.log("");
  console.log("Summary");
  console.log(`  repos             : ${data.counts.repos}`);
  console.log(`  repos with skills : ${data.counts.reposWithSkills}`);
  console.log(`  invalid repos     : ${data.counts.invalidRepos}`);
  console.log(`  skills scanned    : ${data.counts.skillsScanned}`);
  console.log(`  missing canonical : ${data.counts.missingCanonical}`);
  console.log(`  identical         : ${data.counts.identical}`);
  console.log(`  conflicts         : ${data.counts.conflicts}`);
  if (data.mode === "apply") {
    console.log(`  copied            : ${data.counts.copied}`);
  }
  console.log(`Result: ${data.result}`);
}
NODE
