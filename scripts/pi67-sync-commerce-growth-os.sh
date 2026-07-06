#!/usr/bin/env bash
set -euo pipefail

# Maintainer helper: refresh pi-67's vendored commerce-growth-os distribution
# copy from the standalone upstream skill repository.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR="${COMMERCE_GROWTH_OS_REPO:-}"
DEST_DIR="$REPO_ROOT/shared-skills/commerce-growth-os"
APPLY=false
YES=false
VALIDATE=true
OUTPUT_FORMAT="text"

usage() {
  cat <<'USAGE'
pi67-sync-commerce-growth-os refreshes the vendored commerce-growth-os skill.

Usage:
  scripts/pi67-sync-commerce-growth-os.sh [options]

Options:
      --source DIR     commerce-growth-os checkout. Defaults to
                       $COMMERCE_GROWTH_OS_REPO, then ../commerce-growth-os
                       next to this pi-67 checkout.
      --dest DIR       Vendored destination. Defaults to
                       shared-skills/commerce-growth-os in this repo.
      --dry-run        Preview only. This is the default.
      --apply          Replace the destination with a filtered source copy.
  -y, --yes            Required with --apply.
      --no-validate    Skip post-apply skill validation.
      --json           Emit machine-readable JSON.
  -h, --help           Show this help.

The helper refuses sources whose SKILL.md frontmatter name is not
commerce-growth-os. It filters repository/cache/private-eval artifacts such as
.git, node_modules, .venv, coverage, build output, and eval/answers.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:?--source requires a path}"
      shift 2
      ;;
    --dest)
      DEST_DIR="${2:?--dest requires a path}"
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
    --no-validate)
      VALIDATE=false
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

if [ -z "$SOURCE_DIR" ]; then
  SOURCE_DIR="$REPO_ROOT/../commerce-growth-os"
fi

if [ "$APPLY" = true ] && [ "$YES" != true ]; then
  echo "--apply requires --yes" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-sync-commerce-growth-os" >&2
  exit 1
fi

node - "$SOURCE_DIR" "$DEST_DIR" "$APPLY" "$OUTPUT_FORMAT" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const [, , sourceDirRaw, destDirRaw, applyRaw, outputFormat] = process.argv;
const sourceDir = path.resolve(sourceDirRaw);
const destDir = path.resolve(destDirRaw);
const apply = applyRaw === "true";
const expectedName = "commerce-growth-os";

const ignoredNames = new Set([
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

const ignoredRelativePaths = new Set(["eval/answers"]);

function displayPath(value) {
  const home = os.homedir();
  return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function shouldSkip(fullPath, baseDir) {
  const relative = path.relative(baseDir, fullPath).split(path.sep).join("/");
  if (!relative) return false;
  if (ignoredRelativePaths.has(relative)) return true;
  return relative.split("/").some((part) => ignoredNames.has(part));
}

function readSkillName(skillDir) {
  const skillFile = path.join(skillDir, "SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const name = frontmatter?.[1]?.match(/^name:\s*["']?([^"'\n#]+)["']?\s*$/m)?.[1]?.trim();
  return name || path.basename(skillDir);
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
    if (shouldSkip(full, base)) continue;
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

function fingerprint(dir) {
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return "missing";
  const hash = crypto.createHash("sha256");
  for (const item of collectFileHashes(dir)) {
    hash.update(item);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  function copyDir(current, base, targetRoot) {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (shouldSkip(full, base)) continue;
      const out = path.join(targetRoot, path.relative(base, full));
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.mkdirSync(out, { recursive: true });
        copyDir(full, base, targetRoot);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(full, out);
        fs.chmodSync(out, stat.mode);
      }
    }
  }
  copyDir(src, src, dest);
}

function replaceDestination(src, dest) {
  const parent = path.dirname(dest);
  const basename = path.basename(dest);
  fs.mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const tempDest = path.join(parent, `.${basename}.tmp-${stamp}`);
  const oldDest = path.join(parent, `.${basename}.old-${stamp}`);
  let movedOld = false;
  try {
    copyFiltered(src, tempDest);
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, oldDest);
      movedOld = true;
    }
    fs.renameSync(tempDest, dest);
    if (movedOld) {
      fs.rmSync(oldDest, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(tempDest, { recursive: true, force: true });
    if (movedOld && !fs.existsSync(dest) && fs.existsSync(oldDest)) {
      fs.renameSync(oldDest, dest);
    }
    throw error;
  }
}

const report = {
  schemaVersion: 1,
  schemaId: "pi67-commerce-growth-os-sync/v1",
  generatedAt: new Date().toISOString(),
  mode: apply ? "apply" : "dry-run",
  source: displayPath(sourceDir),
  destination: displayPath(destDir),
  sourceExists: fs.existsSync(sourceDir),
  destinationExists: fs.existsSync(destDir),
  expectedName,
  actualName: null,
  sourceHash: "missing",
  destinationHash: "missing",
  status: "invalid-source",
  result: "INVALID_INPUT",
  copied: false,
  ignored: {
    names: Array.from(ignoredNames).sort(),
    relativePaths: Array.from(ignoredRelativePaths).sort(),
  },
};

try {
  if (!report.sourceExists) {
    throw new Error("source directory does not exist");
  }
  if (!fs.existsSync(path.join(sourceDir, "SKILL.md"))) {
    throw new Error("source directory does not contain SKILL.md");
  }
  report.actualName = readSkillName(sourceDir);
  if (report.actualName !== expectedName) {
    throw new Error(`unexpected skill name: ${report.actualName}`);
  }
  if (path.basename(destDir) !== expectedName) {
    throw new Error(`destination basename must be ${expectedName}`);
  }
  if (sourceDir === destDir) {
    throw new Error("source and destination must be different directories");
  }

  report.sourceHash = fingerprint(sourceDir);
  report.destinationHash = fingerprint(destDir);
  if (report.destinationHash === "missing") {
    report.status = "missing-destination";
    report.result = apply ? "APPLIED" : "READY_TO_APPLY";
  } else if (report.sourceHash === report.destinationHash) {
    report.status = "identical";
    report.result = "NOOP";
  } else {
    report.status = "different";
    report.result = apply ? "APPLIED" : "READY_TO_APPLY";
  }

  if (apply && report.result === "APPLIED") {
    replaceDestination(sourceDir, destDir);
    report.destinationExists = true;
    report.destinationHash = fingerprint(destDir);
    report.copied = true;
  }
} catch (error) {
  report.error = String(error?.message || error);
}

if (outputFormat === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log("pi-67 commerce-growth-os sync");
  console.log(`Mode        : ${report.mode}`);
  console.log(`Source      : ${report.source}`);
  console.log(`Destination : ${report.destination}`);
  console.log(`Status      : ${report.status}`);
  console.log(`Result      : ${report.result}`);
  if (report.error) {
    console.log(`Error       : ${report.error}`);
  }
  if (report.result === "READY_TO_APPLY") {
    console.log("");
    console.log("Next step:");
    console.log("  bash scripts/pi67-sync-commerce-growth-os.sh --apply --yes");
  }
}

if (report.result === "INVALID_INPUT") {
  process.exit(1);
}
NODE

if [ "$APPLY" = true ] && [ "$VALIDATE" = true ]; then
  VALIDATOR="$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py"
  if [ -f "$DEST_DIR/scripts/validate.sh" ] && [ -f "$VALIDATOR" ]; then
    echo "" >&2
    echo "Running commerce-growth-os validation: $DEST_DIR/scripts/validate.sh" >&2
    bash "$DEST_DIR/scripts/validate.sh" >&2
  elif [ -f "$DEST_DIR/scripts/validate.sh" ]; then
    echo "WARN skipped commerce-growth-os validation because quick_validate.py was not found: $VALIDATOR" >&2
  fi
fi
