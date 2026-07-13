#!/usr/bin/env node
import path from "node:path";
import { inspectUpstreamPiRuntime, upstreamPiCheck } from "../packages/pi67-cli/src/lib/upstream-pi-runtime.mjs";

const options = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(options.repoRoot || path.join(import.meta.dirname, ".."));
const agentDir = path.resolve(options.agentDir || repoRoot);
const runtime = await inspectUpstreamPiRuntime({
  repoRoot,
  agentDir,
  skillsDir: options.skillsDir ? path.resolve(options.skillsDir) : path.join(agentDir, "shared-skills"),
  packagesDir: path.join(agentDir, "packages"),
}, {
  noRemote: options.noRemote,
});
const check = upstreamPiCheck(runtime);
const output = {
  schema: "pi67.upstream-pi-runtime.v1",
  ...runtime,
  check,
};

if (options.check && !options.json) {
  process.stdout.write(`${check.level}|${check.message}\n`);
} else {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function parseArgs(argv) {
  const result = {
    agentDir: "",
    repoRoot: "",
    skillsDir: "",
    check: false,
    json: false,
    noRemote: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-dir") result.agentDir = argv[++index] || "";
    else if (arg === "--repo-root") result.repoRoot = argv[++index] || "";
    else if (arg === "--skills-dir") result.skillsDir = argv[++index] || "";
    else if (arg === "--check") result.check = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--no-remote") result.noRemote = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}
