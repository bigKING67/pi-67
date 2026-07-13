#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SKILL_PACK_LOCK_SCHEMA,
  buildPackLockEntry,
  hashDirectory,
} from "../packages/pi67-cli/src/lib/skill-pack-integrity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACK_NAME = "consumer-brand-commerce-marketing-suite";
const UPSTREAM = "https://github.com/bigKING67/commerce-growth-os";
const EXPECTED_SKILLS = [
  "commerce-growth-os",
  "commerce-commercial-strategy",
  "commerce-operations",
  "commerce-analytics",
  "consumer-marketing-os",
  "brand-strategy-communications",
  "content-creative-social-marketing",
  "growth-performance-lifecycle-marketing",
];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (options.apply && !options.yes) {
  failUsage("--apply requires --yes");
}

const sourceDir = path.resolve(
  options.source ||
  process.env.COMMERCE_SKILL_PACK_REPO ||
  process.env.COMMERCE_GROWTH_OS_REPO ||
  path.join(REPO_ROOT, "..", "commerce-growth-os"),
);
let destRoot = path.resolve(options.destRoot || path.join(REPO_ROOT, "shared-skills"));
if (options.legacyDest) {
  const legacyDest = path.resolve(options.legacyDest);
  if (path.basename(legacyDest) !== "commerce-growth-os") {
    failUsage("legacy --dest must end with commerce-growth-os");
  }
  destRoot = path.dirname(legacyDest);
}
const registryPath = path.resolve(options.packRegistry || path.join(REPO_ROOT, "shared-skill-packs.json"));
const lockPath = path.resolve(options.packLock || path.join(REPO_ROOT, "shared-skill-packs.lock.json"));

const report = {
  schemaVersion: 1,
  schemaId: "pi67-commerce-skill-pack-sync/v1",
  generatedAt: new Date().toISOString(),
  mode: options.apply ? "apply" : "dry-run",
  source: displayPath(sourceDir),
  destinationRoot: displayPath(destRoot),
  packRegistry: displayPath(registryPath),
  packLock: displayPath(lockPath),
  packName: PACK_NAME,
  packVersion: null,
  sourceExists: fs.existsSync(sourceDir),
  registryChanged: false,
  lockChanged: false,
  provenance: {
    sourceCommit: "",
    manifestSha256: "",
    bundleSha256: "",
  },
  counts: {
    skills: EXPECTED_SKILLS.length,
    identical: 0,
    create: 0,
    replace: 0,
    applied: 0,
  },
  skills: [],
  result: "INVALID_INPUT",
};

let tempRoot;
try {
  const manifest = loadManifest(sourceDir);
  report.packVersion = manifest.pack_version;
  const sourceCommit = resolveSourceCommit(sourceDir);
  report.provenance.sourceCommit = sourceCommit;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-commerce-skill-pack-"));
  const buildRoot = path.join(tempRoot, "bundles");
  buildBundles(sourceDir, buildRoot);
  validateBuiltBundles(buildRoot, manifest);

  for (const name of EXPECTED_SKILLS) {
    const source = path.join(buildRoot, name);
    const destination = path.join(destRoot, name);
    const sourceHash = hashDirectory(source);
    const destinationExists = fs.existsSync(path.join(destination, "SKILL.md"));
    const destinationHash = destinationExists ? hashDirectory(destination) : "missing";
    const status = !destinationExists
      ? "create"
      : sourceHash === destinationHash
        ? "identical"
        : "replace";
    report.counts[status] += 1;
    report.skills.push({
      name,
      status,
      source: `${displayPath(sourceDir)}#bundle/${name}`,
      destination: displayPath(destination),
      sourceHash,
      destinationHash,
    });
  }

  const registryUpdate = buildRegistryUpdate(registryPath, manifest);
  const lockUpdate = buildLockUpdate(lockPath, manifest, sourceCommit, buildRoot);
  report.registryChanged = registryUpdate.changed;
  report.lockChanged = lockUpdate.changed;
  report.provenance.manifestSha256 = lockUpdate.entry.manifest_sha256;
  report.provenance.bundleSha256 = lockUpdate.entry.bundle_sha256;
  const hasChanges = report.counts.create > 0 ||
    report.counts.replace > 0 ||
    report.registryChanged ||
    report.lockChanged;
  report.result = hasChanges ? (options.apply ? "APPLIED" : "READY_TO_APPLY") : "NOOP";

  if (options.apply && hasChanges) {
    applyTransaction(
      buildRoot,
      destRoot,
      registryPath,
      registryUpdate.text,
      lockPath,
      lockUpdate.text,
      report,
    );
    report.counts.applied = report.counts.create + report.counts.replace;
    for (const skill of report.skills) {
      skill.destinationHash = hashDirectory(path.join(destRoot, skill.name));
      if (skill.destinationHash !== skill.sourceHash) {
        throw new Error(`post-apply hash mismatch: ${skill.name}`);
      }
    }
  }
} catch (error) {
  report.error = String(error?.message || error);
  report.result = "INVALID_INPUT";
} finally {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
}

printReport(report, options.json);
if (report.result === "INVALID_INPUT") process.exit(1);

function parseArgs(argv) {
  const result = {
    apply: false,
    yes: false,
    json: false,
    help: false,
    source: "",
    destRoot: "",
    legacyDest: "",
    packRegistry: "",
    packLock: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") result.source = requiredValue(argv, ++index, arg);
    else if (arg === "--dest-root") result.destRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--dest") result.legacyDest = requiredValue(argv, ++index, arg);
    else if (arg === "--pack-registry") result.packRegistry = requiredValue(argv, ++index, arg);
    else if (arg === "--pack-lock") result.packLock = requiredValue(argv, ++index, arg);
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--apply") result.apply = true;
    else if (arg === "--yes" || arg === "-y") result.yes = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--no-validate") {
      // Retained as a no-op compatibility flag. The upstream bundle build is always validated.
    } else if (arg === "--help" || arg === "-h") result.help = true;
    else failUsage(`unknown option: ${arg}`);
  }
  return result;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) failUsage(`${option} requires a value`);
  return value;
}

function loadManifest(source) {
  const manifestFile = path.join(source, "skill-pack.json");
  if (!fs.existsSync(manifestFile)) throw new Error("source does not contain skill-pack.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schema_version !== 2 || manifest.pack_name !== PACK_NAME) {
    throw new Error(`unexpected pack manifest: ${manifest.pack_name || "missing"}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.pack_version || "")) {
    throw new Error(`invalid pack version: ${manifest.pack_version || "missing"}`);
  }
  const names = (manifest.skills || []).map((skill) => skill?.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_SKILLS)) {
    throw new Error("pack skills do not match the reviewed pi-67 distribution contract");
  }
  return manifest;
}

function resolveSourceCommit(source) {
  const revision = spawnSync("git", ["-C", source, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  });
  const commit = String(revision.stdout || "").trim();
  if (revision.status !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("source must be a Git checkout with a resolvable full commit");
  }
  const status = spawnSync("git", ["-C", source, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error("could not inspect source Git worktree state");
  if (String(status.stdout || "").trim()) {
    throw new Error("source Git worktree must be clean before vendoring a Skill Pack");
  }
  return commit;
}

function buildBundles(source, output) {
  const installer = path.join(source, "scripts", "install.sh");
  if (!fs.existsSync(installer)) throw new Error("source does not contain scripts/install.sh");
  const result = spawnSync("bash", [installer, "--build-only", "--output", output], {
    cwd: source,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-4000);
    throw new Error(`upstream bundle build failed${detail ? `:\n${detail}` : ""}`);
  }
}

function validateBuiltBundles(buildRoot, manifest) {
  const expected = new Set(EXPECTED_SKILLS);
  const actual = fs.readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`built bundle set mismatch: ${actual.join(", ")}`);
  }
  for (const skill of manifest.skills) {
    const dir = path.join(buildRoot, skill.name);
    const skillFile = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillFile)) throw new Error(`built Skill is missing SKILL.md: ${skill.name}`);
    const text = fs.readFileSync(skillFile, "utf8");
    const name = text.match(/^---\s*\n[\s\S]*?^name:\s*([^\n#]+)$/m)?.[1]?.trim();
    if (name !== skill.name) throw new Error(`built Skill frontmatter mismatch: ${skill.name}`);
    if (containsSymlink(dir)) throw new Error(`built Skill contains a symlink: ${skill.name}`);
  }
}

function containsSymlink(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && containsSymlink(full)) return true;
  }
  return false;
}

function buildRegistryUpdate(file, manifest) {
  const original = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema: "pi67.shared-skill-packs.v1", packs: [] };
  if (original.schema !== "pi67.shared-skill-packs.v1" || !Array.isArray(original.packs)) {
    throw new Error("invalid shared-skill-packs.json schema");
  }
  const next = structuredClone(original);
  const entry = {
    name: PACK_NAME,
    version: manifest.pack_version,
    upstream: UPSTREAM,
    sync_helper: "scripts/pi67-sync-commerce-skill-pack.sh",
    skills: [...EXPECTED_SKILLS],
  };
  const index = next.packs.findIndex((pack) => pack.name === PACK_NAME);
  if (index >= 0) next.packs[index] = entry;
  else next.packs.push(entry);
  next.packs.sort((left, right) => left.name.localeCompare(right.name));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { changed: currentText !== text, text };
}

function buildLockUpdate(file, manifest, sourceCommit, buildRoot) {
  const original = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema: SKILL_PACK_LOCK_SCHEMA, packs: [] };
  if (original.schema !== SKILL_PACK_LOCK_SCHEMA || !Array.isArray(original.packs)) {
    throw new Error("invalid shared-skill-packs.lock.json schema");
  }
  const next = structuredClone(original);
  const entry = buildPackLockEntry({
    name: PACK_NAME,
    version: manifest.pack_version,
    upstream: UPSTREAM,
    sourceCommit,
    manifestFile: path.join(sourceDir, "skill-pack.json"),
    skillNames: EXPECTED_SKILLS,
    skillRoot: buildRoot,
  });
  const index = next.packs.findIndex((pack) => pack.name === PACK_NAME);
  if (index >= 0) next.packs[index] = entry;
  else next.packs.push(entry);
  next.packs.sort((left, right) => left.name.localeCompare(right.name));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { changed: currentText !== text, entry, text };
}

function applyTransaction(
  buildRoot,
  destinationRoot,
  packRegistry,
  registryText,
  packLock,
  lockText,
  data,
) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const transactionRoot = path.join(destinationRoot, `.commerce-skill-pack-sync-${stamp}`);
  const stagedRoot = path.join(transactionRoot, "staged");
  const previousRoot = path.join(transactionRoot, "previous");
  const changedSkills = data.skills.filter((skill) => skill.status !== "identical");
  const activated = [];
  const movedPrevious = [];
  const registryExisted = fs.existsSync(packRegistry);
  const registryOriginal = registryExisted ? fs.readFileSync(packRegistry) : null;
  const lockExisted = fs.existsSync(packLock);
  const lockOriginal = lockExisted ? fs.readFileSync(packLock) : null;

  try {
    fs.mkdirSync(stagedRoot, { recursive: true });
    for (const skill of changedSkills) {
      fs.cpSync(path.join(buildRoot, skill.name), path.join(stagedRoot, skill.name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    for (const skill of changedSkills) {
      const target = path.join(destinationRoot, skill.name);
      if (!fs.existsSync(target)) continue;
      fs.mkdirSync(previousRoot, { recursive: true });
      fs.renameSync(target, path.join(previousRoot, skill.name));
      movedPrevious.push(skill.name);
    }
    for (const skill of changedSkills) {
      fs.renameSync(path.join(stagedRoot, skill.name), path.join(destinationRoot, skill.name));
      activated.push(skill.name);
    }
    if (data.registryChanged) {
      fs.mkdirSync(path.dirname(packRegistry), { recursive: true });
      fs.writeFileSync(packRegistry, registryText, "utf8");
    }
    if (data.lockChanged) {
      fs.mkdirSync(path.dirname(packLock), { recursive: true });
      fs.writeFileSync(packLock, lockText, "utf8");
    }
    for (const skill of changedSkills) {
      const activatedHash = hashDirectory(path.join(destinationRoot, skill.name));
      if (activatedHash !== skill.sourceHash) {
        throw new Error(`transactional activation hash mismatch: ${skill.name}`);
      }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    for (const name of activated.reverse()) {
      fs.rmSync(path.join(destinationRoot, name), { recursive: true, force: true });
    }
    for (const name of movedPrevious.reverse()) {
      const previous = path.join(previousRoot, name);
      if (fs.existsSync(previous)) fs.renameSync(previous, path.join(destinationRoot, name));
    }
    if (data.registryChanged) {
      if (registryExisted) fs.writeFileSync(packRegistry, registryOriginal);
      else fs.rmSync(packRegistry, { force: true });
    }
    if (data.lockChanged) {
      if (lockExisted) fs.writeFileSync(packLock, lockOriginal);
      else fs.rmSync(packLock, { force: true });
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

function displayPath(value) {
  const home = os.homedir();
  return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function printReport(data, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  console.log("");
  console.log("pi-67 Consumer Brand Commerce and Marketing Skill Pack sync");
  console.log(`Mode        : ${data.mode}`);
  console.log(`Source      : ${data.source}`);
  console.log(`Destination : ${data.destinationRoot}`);
  console.log(`Pack        : ${data.packName}@${data.packVersion || "unknown"}`);
  console.log(`Result      : ${data.result}`);
  if (data.error) console.log(`Error       : ${data.error}`);
  for (const skill of data.skills) console.log(`  ${skill.status.padEnd(9)} ${skill.name}`);
  if (data.result === "READY_TO_APPLY") {
    console.log("");
    console.log("Next step:");
    console.log("  bash scripts/pi67-sync-commerce-skill-pack.sh --apply --yes");
  }
}

function printHelp() {
  process.stdout.write(`pi67-sync-commerce-skill-pack refreshes pi-67's vendored eight-Skill pack.

Usage:
  scripts/pi67-sync-commerce-skill-pack.sh [options]

Options:
      --source DIR         Upstream commerce-growth-os checkout. Defaults to
                           $COMMERCE_SKILL_PACK_REPO, legacy
                           $COMMERCE_GROWTH_OS_REPO, then ../commerce-growth-os.
      --dest-root DIR      Vendored shared-skills root. Defaults to this repo's
                           shared-skills directory.
      --dest DIR           Legacy alias accepting a commerce-growth-os destination.
      --pack-registry FILE Pack registry. Defaults to shared-skill-packs.json.
      --pack-lock FILE     Immutable provenance lock. Defaults to
                           shared-skill-packs.lock.json.
      --dry-run            Build and compare without writing. This is the default.
      --apply              Transactionally replace/create the eight vendored Skills.
  -y, --yes                Required with --apply.
      --json               Emit pi67-commerce-skill-pack-sync/v1 JSON.
  -h, --help               Show this help.

The helper requires a clean upstream Git checkout, runs the manifest builder,
verifies the reviewed eight-Skill contract, updates the registry and provenance
lock, and rolls back the vendored set if an apply operation fails.
`);
}

function failUsage(message) {
  console.error(message);
  console.error("Run with --help for usage.");
  process.exit(2);
}
