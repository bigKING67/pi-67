#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SKILL_PACK_LOCK_SCHEMA,
  buildPackLockEntry,
  hashDirectory,
  hashSkillSet,
} from "../packages/pi67-cli/src/lib/skill-pack-integrity.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACK_NAME = "ai-berkshire-investment-suite";
const INITIAL_PACK_VERSION = "1.0.0";
const UPSTREAM = "https://github.com/xbtlin/ai-berkshire";
const SYNC_HELPER = "scripts/pi67-sync-ai-berkshire-skill-pack.sh";
const SOURCE_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/?)xbtlin\/ai-berkshire(?:\.git)?\/?$/i;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_FILE = /^[A-Za-z0-9_.-]+\.py$/;

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (options.apply && !options.yes) failUsage("--apply requires --yes");

const sourceDir = path.resolve(
  options.source || process.env.AI_BERKSHIRE_REPO || path.join(REPO_ROOT, "..", "ai-berkshire"),
);
const destRoot = path.resolve(options.destRoot || path.join(REPO_ROOT, "shared-skills"));
const registryPath = path.resolve(options.packRegistry || path.join(REPO_ROOT, "shared-skill-packs.json"));
const lockPath = path.resolve(options.packLock || path.join(REPO_ROOT, "shared-skill-packs.lock.json"));

const report = {
  schemaVersion: 1,
  schemaId: "pi67-ai-berkshire-skill-pack-sync/v1",
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
  reviewLevel: "none",
  skillSetChange: { added: [], removed: [] },
  provenance: { sourceCommit: "", sourceManifestSha256: "", bundleSha256: "" },
  counts: { skills: 0, identical: 0, create: 0, replace: 0, remove: 0, applied: 0 },
  skills: [],
  result: "INVALID_INPUT",
};

let tempRoot;
try {
  const source = inspectSource(sourceDir);
  report.provenance.sourceCommit = source.commit;
  report.counts.skills = source.skills.length;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-ai-berkshire-pack-"));
  const buildRoot = path.join(tempRoot, "bundles");
  const sourceManifestFile = path.join(tempRoot, "source-manifest.json");
  buildBundles(source, buildRoot, sourceManifestFile);
  validateBuiltBundles(buildRoot, source.skills);

  const registry = readRegistry(registryPath);
  const lock = readLock(lockPath);
  const previousPack = registry.packs.find((entry) => entry.name === PACK_NAME) || null;
  const previousLock = lock.packs.find((entry) => entry.name === PACK_NAME) || null;
  const skillNames = source.skills.map((skill) => skill.name);
  const skillHashes = skillNames.map((name) => ({
    name,
    sha256: hashDirectory(path.join(buildRoot, name)),
  }));
  const bundleSha256 = hashSkillSet(skillHashes);
  const versionDecision = choosePackVersion(
    previousPack,
    previousLock,
    source.commit,
    skillNames,
    bundleSha256,
    options.packVersion,
  );
  report.packVersion = versionDecision.version;
  report.reviewLevel = versionDecision.reviewLevel;
  report.skillSetChange = versionDecision.skillSetChange;

  for (const name of skillNames) {
    const sourcePath = path.join(buildRoot, name);
    const destination = path.join(destRoot, name);
    const sourceHash = hashDirectory(sourcePath);
    const destinationExists = fs.existsSync(path.join(destination, "SKILL.md"));
    const destinationHash = destinationExists ? hashDirectory(destination) : "missing";
    const status = !destinationExists ? "create" : sourceHash === destinationHash ? "identical" : "replace";
    report.counts[status] += 1;
    report.skills.push({
      name,
      status,
      source: `${displayPath(sourceDir)}/codex-skills/${name}`,
      destination: displayPath(destination),
      sourceHash,
      destinationHash,
    });
  }
  for (const name of versionDecision.skillSetChange.removed) {
    const destination = path.join(destRoot, name);
    if (!fs.existsSync(destination)) continue;
    const destinationHash = hashDirectory(destination);
    const previousHash = previousLock?.skills?.find((skill) => skill?.name === name)?.sha256 || "";
    if (!previousHash || destinationHash !== previousHash) {
      throw new Error(`refusing to remove a vendored Skill that differs from the previous lock: ${name}`);
    }
    report.counts.remove += 1;
    report.skills.push({
      name,
      status: "remove",
      source: null,
      destination: displayPath(destination),
      sourceHash: null,
      destinationHash,
    });
  }

  const registryUpdate = buildRegistryUpdate(registry, registryPath, versionDecision.version, skillNames);
  const lockUpdate = buildLockUpdate(
    lock,
    lockPath,
    versionDecision.version,
    source.commit,
    sourceManifestFile,
    skillNames,
    buildRoot,
  );
  report.registryChanged = registryUpdate.changed;
  report.lockChanged = lockUpdate.changed;
  report.provenance.sourceManifestSha256 = lockUpdate.entry.manifest_sha256;
  report.provenance.bundleSha256 = lockUpdate.entry.bundle_sha256;

  const hasChanges = report.counts.create > 0 || report.counts.replace > 0 || report.counts.remove > 0
    || report.registryChanged || report.lockChanged;
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
    report.counts.applied = report.counts.create + report.counts.replace + report.counts.remove;
    for (const skill of report.skills) {
      if (skill.status === "remove") {
        if (fs.existsSync(path.join(destRoot, skill.name))) throw new Error(`post-apply removal failed: ${skill.name}`);
        skill.destinationHash = "missing";
        continue;
      }
      skill.destinationHash = hashDirectory(path.join(destRoot, skill.name));
      if (skill.destinationHash !== skill.sourceHash) throw new Error(`post-apply hash mismatch: ${skill.name}`);
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
    packRegistry: "",
    packLock: "",
    packVersion: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") result.source = requiredValue(argv, ++index, arg);
    else if (arg === "--dest-root") result.destRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--pack-registry") result.packRegistry = requiredValue(argv, ++index, arg);
    else if (arg === "--pack-lock") result.packLock = requiredValue(argv, ++index, arg);
    else if (arg === "--pack-version") result.packVersion = requiredValue(argv, ++index, arg);
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--apply") result.apply = true;
    else if (arg === "--yes" || arg === "-y") result.yes = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else failUsage(`unknown option: ${arg}`);
  }
  return result;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) failUsage(`${option} requires a value`);
  return value;
}

function inspectSource(source) {
  const skillRoot = path.join(source, "codex-skills");
  const toolsRoot = path.join(source, "tools");
  const licenseFile = path.join(source, "LICENSE");
  if (!fs.existsSync(skillRoot)) throw new Error("source does not contain codex-skills/");
  if (!fs.existsSync(toolsRoot)) throw new Error("source does not contain tools/");
  if (!fs.existsSync(licenseFile)) throw new Error("source does not contain LICENSE");
  if (containsSymlink(skillRoot) || containsSymlink(toolsRoot) || fs.lstatSync(licenseFile).isSymbolicLink()) {
    throw new Error("source Skill or tool inputs must not contain symlinks");
  }

  const revision = runGit(source, ["rev-parse", "--verify", "HEAD"]);
  const commit = revision.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("source must be a Git checkout with a resolvable full commit");
  }
  const worktree = runGit(source, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (worktree.trim()) throw new Error("source Git worktree must be clean before vendoring a Skill Pack");
  const origin = runGit(source, ["config", "--get", "remote.origin.url"]).trim();
  if (!SOURCE_ORIGIN.test(origin)) throw new Error(`unexpected AI Berkshire origin: ${origin || "missing"}`);

  const skills = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillRoot, entry.name, "SKILL.md")))
    .map((entry) => inspectSkill(skillRoot, toolsRoot, entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (skills.length === 0) throw new Error("source has no codex-skills/*/SKILL.md packages");
  return { source, skillRoot, toolsRoot, licenseFile, commit, origin, skills };
}

function inspectSkill(skillRoot, toolsRoot, directoryName) {
  if (!SKILL_NAME.test(directoryName)) throw new Error(`invalid Skill directory name: ${directoryName}`);
  const sourceFile = path.join(skillRoot, directoryName, "SKILL.md");
  const sourceText = fs.readFileSync(sourceFile, "utf8");
  const parsed = splitSkill(sourceText);
  const name = frontmatterValue(parsed.frontmatter, "name");
  const description = frontmatterValue(parsed.frontmatter, "description");
  if (name !== directoryName) throw new Error(`Skill frontmatter name mismatch: ${directoryName}`);
  if (!description) throw new Error(`Skill is missing a description: ${directoryName}`);

  const tools = new Set();
  for (const match of sourceText.matchAll(/tools\/([A-Za-z0-9_.-]+\.py)\b/g)) tools.add(match[1]);
  const availableTools = fs.readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TOOL_FILE.test(entry.name))
    .map((entry) => entry.name);
  for (const tool of availableTools) {
    if (new RegExp(`(^|[^A-Za-z0-9_./])${escapeRegExp(tool)}\\b`, "m").test(sourceText)) tools.add(tool);
  }
  for (const tool of tools) {
    const toolPath = path.join(toolsRoot, tool);
    if (!TOOL_FILE.test(tool) || !fs.existsSync(toolPath) || !fs.statSync(toolPath).isFile()) {
      throw new Error(`Skill ${directoryName} references a missing or invalid tool: ${tool}`);
    }
    if (fs.statSync(toolPath).size > 1024 * 1024) throw new Error(`Skill tool exceeds 1 MiB: ${tool}`);
  }
  return { name: directoryName, sourceFile, sourceText, tools: [...tools].sort() };
}

function buildBundles(source, output, sourceManifestFile) {
  fs.mkdirSync(output, { recursive: true });
  const sourceFiles = new Map();
  sourceFiles.set("LICENSE", sha256File(source.licenseFile));
  for (const skill of source.skills) {
    const destination = path.join(output, skill.name);
    const scriptsDir = path.join(destination, "scripts");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "SKILL.md"), adaptSkill(skill, source.commit), "utf8");
    fs.copyFileSync(source.licenseFile, path.join(destination, "LICENSE"));
    sourceFiles.set(`codex-skills/${skill.name}/SKILL.md`, sha256File(skill.sourceFile));
    for (const tool of skill.tools) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      const sourceTool = path.join(source.toolsRoot, tool);
      const destinationTool = path.join(scriptsDir, tool);
      fs.writeFileSync(destinationTool, adaptTool(fs.readFileSync(sourceTool, "utf8")), "utf8");
      fs.chmodSync(destinationTool, 0o755);
      sourceFiles.set(`tools/${tool}`, sha256File(sourceTool));
    }
    fs.writeFileSync(
      path.join(destination, "UPSTREAM.json"),
      `${JSON.stringify({
        schema: "pi67.ai-berkshire-skill-provenance.v1",
        repository: UPSTREAM,
        source_commit: source.commit,
        source_path: `codex-skills/${skill.name}/SKILL.md`,
        pack: PACK_NAME,
      }, null, 2)}\n`,
      "utf8",
    );
  }
  const manifest = {
    schema: "pi67.ai-berkshire-source-manifest.v1",
    repository: UPSTREAM,
    source_commit: source.commit,
    skills: source.skills.map((skill) => skill.name),
    files: [...sourceFiles.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, sha256]) => ({ file, sha256 })),
  };
  fs.writeFileSync(sourceManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function adaptTool(sourceText) {
  return sourceText.replace(/tools\/([A-Za-z0-9_.-]+\.py)\b/g, "scripts/$1");
}

function adaptSkill(skill, sourceCommit) {
  const parsed = splitSkill(skill.sourceText);
  let frontmatter = parsed.frontmatter.replace(
    /Source:\s*skills\/([a-z0-9-]+)\.md\.?/g,
    "Upstream workflow: $1.",
  );
  if (!/^license:\s*/m.test(frontmatter)) frontmatter = `${frontmatter.trimEnd()}\nlicense: MIT (see LICENSE)`;
  if (skill.name === "investment-memo-craft") {
    frontmatter = frontmatter.replace(
      /description:\s*(.*Codex-only.*)$/m,
      (_match, value) => `description: ${value.replace(/Codex-only/g, "Shared Pi/Codex").replace(/whenever Codex/g, "whenever Pi or Codex")}`,
    );
  }

  let body = parsed.body.replace(/^## Codex adapter note\s*\n[\s\S]*?(?=^#\s)/m, "");
  body = body.replace(/`skills\/([a-z0-9-]+)\.md`/g, "`$1` Skill");
  body = body.replace(/skills\/([a-z0-9-]+)\.md/g, "$1 Skill");
  body = body.replace(/tools\/([A-Za-z0-9_.-]+\.py)\b/g, "scripts/$1");
  for (const tool of skill.tools) {
    body = body.replace(new RegExp(`(^|[^A-Za-z0-9_./])${escapeRegExp(tool)}\\b`, "gm"), `$1scripts/${tool}`);
  }
  if (skill.name === "investment-memo-craft") {
    body = body
      .replace(/Codex-only/g, "shared Pi/Codex")
      .replace(/decision-ready Codex research report/g, "decision-ready Pi/Codex research report")
      .replace(/when Codex creates/g, "when Pi or Codex creates");
  }
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(body) || /~\/ai-berkshire\b/.test(body) || /[A-Za-z]:\\Users\\[^<]/.test(body)) {
    throw new Error(`adapted Skill contains a personal absolute path: ${skill.name}`);
  }

  const adapter = `## Shared Pi/Codex adapter note

This Skill is distributed by pi-67 from AI Berkshire commit \`${sourceCommit}\`.

- Treat \`$ARGUMENTS\` as the user's request in the current agent thread.
- Map Claude-only surfaces such as Task, Agent, TeamCreate, TaskCreate, SendMessage, WebSearch, Bash, Read, or Write to capabilities that are actually present in the live host. Never claim a subagent, search, or tool call ran unless it did.
- Team workflows require real delegation authorization and live subagent support. Otherwise complete the perspectives serially and label the execution as degraded.
- Use current Web search/fetch tools for fresh public information. Do not inspect or require Claude permission files; if live search is unavailable, disclose the cutoff and confidence reduction.
- Tool commands below are Skill-relative. Resolve the directory containing this \`SKILL.md\`, change to that directory, and run bundled paths such as \`python3 scripts/financial_rigor.py ...\` (or the platform's equivalent Python 3 launcher).
- References to another AI Berkshire workflow mean the installed sibling Skill of that name.
- Run \`date\` before time-sensitive research, record the data cutoff, cross-check decision-critical figures, use exact arithmetic, and keep source gaps visible.

`;
  return `---\n${frontmatter.trim()}\n---\n\n${adapter}${body.trimStart().trimEnd()}\n`;
}

function splitSkill(text) {
  if (!text.startsWith("---\n")) throw new Error("Skill is missing YAML frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Skill has unterminated YAML frontmatter");
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5).replace(/^\s+/, "") };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
}

function validateBuiltBundles(buildRoot, skills) {
  const expected = skills.map((skill) => skill.name).sort();
  const actual = fs.readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`built bundle set mismatch: ${actual.join(", ")}`);
  for (const name of expected) {
    const dir = path.join(buildRoot, name);
    const skillFile = path.join(dir, "SKILL.md");
    const text = fs.readFileSync(skillFile, "utf8");
    const parsed = splitSkill(text);
    if (frontmatterValue(parsed.frontmatter, "name") !== name) throw new Error(`built Skill frontmatter mismatch: ${name}`);
    if (!frontmatterValue(parsed.frontmatter, "description")) throw new Error(`built Skill description is missing: ${name}`);
    if (!text.includes("## Shared Pi/Codex adapter note")) throw new Error(`built Skill adapter is missing: ${name}`);
    if (/tools\/[A-Za-z0-9_.-]+\.py\b/.test(text)) throw new Error(`built Skill has an unresolved tool path: ${name}`);
    if (/skills\/[a-z0-9-]+\.md\b/.test(text)) throw new Error(`built Skill has an unresolved sibling path: ${name}`);
    if (!fs.existsSync(path.join(dir, "LICENSE")) || !fs.existsSync(path.join(dir, "UPSTREAM.json"))) {
      throw new Error(`built Skill provenance is incomplete: ${name}`);
    }
    if (containsSymlink(dir)) throw new Error(`built Skill contains a symlink: ${name}`);
  }
}

function choosePackVersion(previousPack, previousLock, sourceCommit, skillNames, bundleSha256, requestedVersion) {
  if (!previousPack) {
    const version = requestedVersion || INITIAL_PACK_VERSION;
    parseSemver(version);
    return { version, reviewLevel: "routine", skillSetChange: { added: [...skillNames], removed: [] } };
  }
  const previousNames = Array.isArray(previousPack.skills) ? previousPack.skills : [];
  const added = skillNames.filter((name) => !previousNames.includes(name));
  const removed = previousNames.filter((name) => !skillNames.includes(name));
  if (requestedVersion) {
    parseSemver(requestedVersion);
    const sameSkillSet = added.length === 0 && removed.length === 0;
    const sameSourceCommit = previousLock?.source_commit === sourceCommit;
    if (!sameSourceCommit || !sameSkillSet || requestedVersion !== previousPack.version) {
      throw new Error(
        "--pack-version may only preserve the current version for a same-commit, same-Skill-set adapter refresh",
      );
    }
    return { version: requestedVersion, reviewLevel: "maintainer", skillSetChange: { added, removed } };
  }
  const unchanged = previousLock?.source_commit === sourceCommit && previousLock?.bundle_sha256 === bundleSha256;
  if (unchanged && added.length === 0 && removed.length === 0) {
    return { version: previousPack.version, reviewLevel: "none", skillSetChange: { added, removed } };
  }
  const version = parseSemver(previousPack.version);
  let next;
  let reviewLevel = "routine";
  if (removed.length > 0) {
    next = `${version.major + 1}.0.0`;
    reviewLevel = "manual";
  } else if (added.length > 0) {
    next = `${version.major}.${version.minor + 1}.0`;
    reviewLevel = "manual";
  } else {
    next = `${version.major}.${version.minor}.${version.patch + 1}`;
  }
  return { version: next, reviewLevel, skillSetChange: { added, removed } };
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  if (!match) throw new Error(`invalid existing AI Berkshire Pack version: ${value || "missing"}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function readRegistry(file) {
  const payload = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema: "pi67.shared-skill-packs.v1", packs: [] };
  if (payload.schema !== "pi67.shared-skill-packs.v1" || !Array.isArray(payload.packs)) {
    throw new Error("invalid shared-skill-packs.json schema");
  }
  return payload;
}

function readLock(file) {
  const payload = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema: SKILL_PACK_LOCK_SCHEMA, packs: [] };
  if (payload.schema !== SKILL_PACK_LOCK_SCHEMA || !Array.isArray(payload.packs)) {
    throw new Error("invalid shared-skill-packs.lock.json schema");
  }
  return payload;
}

function buildRegistryUpdate(original, file, version, skillNames) {
  const next = structuredClone(original);
  for (const pack of next.packs) {
    if (pack.name === PACK_NAME) continue;
    const collisions = (pack.skills || []).filter((name) => skillNames.includes(name));
    if (collisions.length > 0) throw new Error(`AI Berkshire Skill name collides with ${pack.name}: ${collisions.join(", ")}`);
  }
  const entry = { name: PACK_NAME, version, upstream: UPSTREAM, sync_helper: SYNC_HELPER, skills: [...skillNames] };
  const index = next.packs.findIndex((pack) => pack.name === PACK_NAME);
  if (index >= 0) next.packs[index] = entry;
  else next.packs.push(entry);
  next.packs.sort((left, right) => left.name.localeCompare(right.name));
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { changed: currentText !== text, text };
}

function buildLockUpdate(original, file, version, sourceCommit, manifestFile, skillNames, buildRoot) {
  const next = structuredClone(original);
  const entry = buildPackLockEntry({
    name: PACK_NAME,
    version,
    upstream: UPSTREAM,
    sourceCommit,
    manifestFile,
    skillNames,
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

function applyTransaction(buildRoot, destinationRoot, packRegistry, registryText, packLock, lockText, data) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  const transactionRoot = path.join(destinationRoot, `.ai-berkshire-pack-sync-${process.pid}-${Date.now()}`);
  const stagedRoot = path.join(transactionRoot, "staged");
  const previousRoot = path.join(transactionRoot, "previous");
  const changedSkills = data.skills.filter((skill) => skill.status === "create" || skill.status === "replace");
  const removedSkills = data.skills.filter((skill) => skill.status === "remove");
  const activated = [];
  const movedPrevious = [];
  const registryExisted = fs.existsSync(packRegistry);
  const registryOriginal = registryExisted ? fs.readFileSync(packRegistry) : null;
  const lockExisted = fs.existsSync(packLock);
  const lockOriginal = lockExisted ? fs.readFileSync(packLock) : null;
  try {
    fs.mkdirSync(stagedRoot, { recursive: true });
    for (const skill of changedSkills) {
      fs.cpSync(path.join(buildRoot, skill.name), path.join(stagedRoot, skill.name), { recursive: true, errorOnExist: true });
    }
    for (const skill of changedSkills) {
      const target = path.join(destinationRoot, skill.name);
      if (!fs.existsSync(target)) continue;
      fs.mkdirSync(previousRoot, { recursive: true });
      fs.renameSync(target, path.join(previousRoot, skill.name));
      movedPrevious.push(skill.name);
    }
    for (const skill of removedSkills) {
      const target = path.join(destinationRoot, skill.name);
      if (!fs.existsSync(target)) throw new Error(`Skill removal target disappeared during transaction: ${skill.name}`);
      if (hashDirectory(target) !== skill.destinationHash) {
        throw new Error(`Skill removal target changed during transaction: ${skill.name}`);
      }
      fs.mkdirSync(previousRoot, { recursive: true });
      fs.renameSync(target, path.join(previousRoot, skill.name));
      movedPrevious.push(skill.name);
    }
    for (const skill of changedSkills) {
      fs.renameSync(path.join(stagedRoot, skill.name), path.join(destinationRoot, skill.name));
      activated.push(skill.name);
    }
    if (data.registryChanged) fs.writeFileSync(packRegistry, registryText, "utf8");
    if (data.lockChanged) fs.writeFileSync(packLock, lockText, "utf8");
    for (const skill of changedSkills) {
      if (hashDirectory(path.join(destinationRoot, skill.name)) !== skill.sourceHash) {
        throw new Error(`transactional activation hash mismatch: ${skill.name}`);
      }
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    for (const name of activated.reverse()) fs.rmSync(path.join(destinationRoot, name), { recursive: true, force: true });
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

function containsSymlink(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && containsSymlink(full)) return true;
  }
  return false;
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  return String(result.stdout || "");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  console.log("pi-67 AI Berkshire Investment Skill Pack sync");
  console.log(`Mode        : ${data.mode}`);
  console.log(`Source      : ${data.source}`);
  console.log(`Destination : ${data.destinationRoot}`);
  console.log(`Pack        : ${data.packName}@${data.packVersion || "unknown"}`);
  console.log(`Source SHA  : ${data.provenance.sourceCommit || "unknown"}`);
  console.log(`Review      : ${data.reviewLevel}`);
  console.log(`Result      : ${data.result}`);
  if (data.error) console.log(`Error       : ${data.error}`);
  for (const skill of data.skills) console.log(`  ${skill.status.padEnd(9)} ${skill.name}`);
  if (data.result === "READY_TO_APPLY") {
    console.log("");
    console.log("Next step:");
    console.log(`  bash ${SYNC_HELPER} --source ${data.source} --apply --yes`);
  }
}

function printHelp() {
  process.stdout.write(`pi67-sync-ai-berkshire-skill-pack refreshes pi-67's vendored AI Berkshire Pack.

Usage:
  scripts/pi67-sync-ai-berkshire-skill-pack.sh [options]

Options:
      --source DIR         Clean xbtlin/ai-berkshire checkout. Defaults to
                           $AI_BERKSHIRE_REPO, then ../ai-berkshire.
      --dest-root DIR      Vendored shared-skills root.
      --pack-registry FILE Pack registry path.
      --pack-lock FILE     Immutable provenance lock path.
      --pack-version VER   Preserve the current version only for a same-commit,
                           same-Skill-set adapter refresh.
      --dry-run            Generate and compare without writing (default).
      --apply              Transactionally create or replace the vendored Pack.
  -y, --yes                Required with --apply.
      --json               Emit pi67-ai-berkshire-skill-pack-sync/v1 JSON.
  -h, --help               Show this help.

The helper never executes upstream code. It requires a clean, correctly
originated Git checkout, adapts Codex packages for shared Pi/Codex use, bundles
referenced Python tools, and updates registry/lock provenance transactionally.
`);
}

function failUsage(message) {
  console.error(message);
  console.error("Run with --help for usage.");
  process.exit(2);
}
