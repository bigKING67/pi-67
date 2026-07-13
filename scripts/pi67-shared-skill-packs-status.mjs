#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSkillPackStatus } from "../packages/pi67-cli/src/lib/skill-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaults = {
  repoRoot: path.resolve(scriptDir, ".."),
  skillsDir: path.join(os.homedir(), ".agents", "skills"),
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const status = inspectSkillPackStatus({
  repoRoot: path.resolve(options.repoRoot || defaults.repoRoot),
  skillsDir: path.resolve(options.skillsDir || defaults.skillsDir),
});
process.stdout.write(`${JSON.stringify(status, null, options.json ? 2 : 0)}\n`);

function parseArgs(argv) {
  const result = { ...defaults, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      result.repoRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--skills-dir") {
      result.skillsDir = requireValue(argv, ++index, arg);
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  return result;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value) fail(`${option} requires a value`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function printHelp() {
  process.stdout.write(`pi67-shared-skill-packs-status - read-only Skill Pack provenance and parity status

Usage:
  node scripts/pi67-shared-skill-packs-status.mjs [--repo-root DIR] [--skills-dir DIR] [--json]

The command validates shared-skill-packs.json plus
shared-skill-packs.lock.json, emits pi67-shared-skill-packs-status/v1 JSON,
and never changes the active shared skill root.
`);
}
