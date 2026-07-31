#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readHyMemoryPythonLock,
} from "../packages/pi67-cli/src/lib/hy-memory-python-runtime.mjs";
import { HY_MEMORY_WHEEL_SHA256 } from "../packages/pi67-cli/src/lib/memory-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = Object.freeze({
  "cp311-macos-arm64": "aarch64-apple-darwin",
  "cp311-manylinux_2_28-x64": "x86_64-manylinux_2_28",
  "cp311-windows-x64": "x86_64-pc-windows-msvc",
});

const options = parseArgs(process.argv.slice(2));
if (options.generate) {
  generateLock(options.target);
} else {
  const checked = Object.keys(targets).map((targetId) => {
    const lock = readHyMemoryPythonLock(root, {
      targetId,
      requireQualified: false,
      hyMemoryWheelSha256: HY_MEMORY_WHEEL_SHA256,
    });
    return {
      target: targetId,
      sha256: lock.lockSha256,
      distributions: lock.requirements.length,
      qualified: lock.target.qualified,
    };
  });
  process.stdout.write(`${JSON.stringify({ schema: "pi67.hy-memory-python-lock-check.v1", success: true, targets: checked })}\n`);
}

function generateLock(targetId) {
  const resolverTarget = targets[targetId];
  if (!resolverTarget) throw new Error(`unknown Hy-Memory Python lock target: ${targetId || "<missing>"}`);
  const output = path.join(root, "extensions", "pi-hy-memory", "python", "locks", `${targetId}.txt`);
  const input = path.join(root, "extensions", "pi-hy-memory", "python", "requirements.in");
  const vendor = path.join(root, "extensions", "pi-hy-memory", "python", "vendor");
  const result = spawnSync("uv", [
    "--no-config",
    "pip",
    "compile",
    input,
    "--python-version",
    "3.11",
    "--python-platform",
    resolverTarget,
    "--generate-hashes",
    "--only-binary",
    ":all:",
    "--find-links",
    vendor,
    "--exclude-newer",
    "2026-07-31T00:00:00Z",
    "--annotation-style",
    "split",
    "--custom-compile-command",
    `node scripts/pi67-hy-memory-python-lock.mjs --generate --target ${targetId}`,
    "--output-file",
    output,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout).trim());
  const bytes = fs.readFileSync(output);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const distributions = String(bytes).split(/\r?\n/).filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/.test(line)).length;
  process.stdout.write(`${JSON.stringify({
    schema: "pi67.hy-memory-python-lock-generation.v1",
    target: targetId,
    output,
    sha256,
    distributions,
    manifestUpdateRequired: true,
  })}\n`);
}

function parseArgs(args) {
  const result = { generate: false, target: "" };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--generate") result.generate = true;
    else if (value === "--target") result.target = args[++index] || "";
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!result.generate && result.target) throw new Error("--target requires --generate");
  return result;
}
