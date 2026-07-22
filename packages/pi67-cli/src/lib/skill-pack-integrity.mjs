import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SKILL_PACK_LOCK_SCHEMA = "pi67.shared-skill-packs-lock.v1";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class SkillPackIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillPackIntegrityError";
  }
}

export function hashDirectory(root) {
  if (!fs.existsSync(root)) return "";
  const hash = crypto.createHash("sha256");
  const files = [];
  walkFiles(root, files);
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(canonicalHashBytes(fs.readFileSync(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(canonicalHashBytes(fs.readFileSync(file)));
  return hash.digest("hex");
}

export function hashSkillSet(skills) {
  const hash = crypto.createHash("sha256");
  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(skill.name);
    hash.update("\0");
    hash.update(skill.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildPackLockEntry({
  name,
  version,
  upstream,
  sourceCommit,
  manifestFile,
  skillNames,
  skillRoot,
}) {
  const skills = skillNames.map((skillName) => ({
    name: skillName,
    sha256: hashDirectory(path.join(skillRoot, skillName)),
  }));
  return {
    name,
    version,
    upstream,
    source_commit: sourceCommit,
    manifest_sha256: hashFile(manifestFile),
    bundle_sha256: hashSkillSet(skills),
    skills,
  };
}

export function readSkillPackLock(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new SkillPackIntegrityError(`invalid shared Skill Pack lock: ${error.message}`);
  }
  if (payload?.schema !== SKILL_PACK_LOCK_SCHEMA || !Array.isArray(payload.packs)) {
    throw new SkillPackIntegrityError("invalid shared Skill Pack lock schema");
  }
  return payload;
}

export function validateSkillPackLock({ lock, registry, sourceHashes }) {
  const registryNames = registry.packs.map((pack) => pack.name).sort();
  const lockNames = lock.packs.map((pack) => pack?.name).sort();
  if (JSON.stringify(lockNames) !== JSON.stringify(registryNames)) {
    throw new SkillPackIntegrityError("shared Skill Pack lock entries do not match the registry");
  }

  const lockByName = new Map();
  for (const pack of registry.packs) {
    const locked = lock.packs.find((entry) => entry?.name === pack.name);
    validateLockedPack(locked, pack, sourceHashes);
    lockByName.set(pack.name, locked);
  }
  return lockByName;
}

function validateLockedPack(locked, pack, sourceHashes) {
  if (!locked || locked.version !== pack.version || locked.upstream !== (pack.upstream || "")) {
    throw new SkillPackIntegrityError(`shared Skill Pack lock metadata mismatch: ${pack.name}`);
  }
  if (!GIT_COMMIT.test(locked.source_commit || "")) {
    throw new SkillPackIntegrityError(`shared Skill Pack ${pack.name} lock requires a full Git commit`);
  }
  if (!SHA256.test(locked.manifest_sha256 || "") || !SHA256.test(locked.bundle_sha256 || "")) {
    throw new SkillPackIntegrityError(`shared Skill Pack ${pack.name} lock requires SHA-256 provenance`);
  }
  if (!Array.isArray(locked.skills)) {
    throw new SkillPackIntegrityError(`shared Skill Pack ${pack.name} lock requires Skill hashes`);
  }

  const lockedNames = locked.skills.map((skill) => skill?.name);
  if (JSON.stringify(lockedNames) !== JSON.stringify(pack.skills)) {
    throw new SkillPackIntegrityError(`shared Skill Pack ${pack.name} lock Skill order mismatch`);
  }
  for (const skill of locked.skills) {
    if (!SHA256.test(skill?.sha256 || "")) {
      throw new SkillPackIntegrityError(`shared Skill Pack ${pack.name} has an invalid hash for ${skill?.name || "unknown"}`);
    }
    const actual = sourceHashes.get(skill.name);
    if (!actual || actual !== skill.sha256) {
      throw new SkillPackIntegrityError(`vendored shared Skill integrity mismatch: ${pack.name}/${skill.name}`);
    }
  }
  if (hashSkillSet(locked.skills) !== locked.bundle_sha256) {
    throw new SkillPackIntegrityError(`shared Skill Pack bundle hash mismatch: ${pack.name}`);
  }
}

function walkFiles(root, output) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, output);
    else if (entry.isFile()) output.push(full);
  }
}

export function canonicalHashBytes(content) {
  if (content.includes(0)) return content;
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return content;
  return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
}
