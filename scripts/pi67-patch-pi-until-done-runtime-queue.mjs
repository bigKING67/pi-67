#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const EXPECTED_VERSION = "0.2.2";
const PACKAGE_NAME = "pi-until-done";

function usage() {
  console.log(`pi67-patch-pi-until-done-runtime-queue

Usage:
  node scripts/pi67-patch-pi-until-done-runtime-queue.mjs [--check] [--apply] [--json] [--agent-dir DIR]
  node scripts/pi67-patch-pi-until-done-runtime-queue.mjs --self-test

The patch is intentionally version-aware. It only rewrites the known
pi-until-done@0.2.2 call sites that use legacy sendUserMessage queue behavior
or miss until_done_* progress signals needed for autonomous follow-up turns.`);
}

const args = process.argv.slice(2);
let checkOnly = false;
let applyPatch = false;
let jsonOutput = false;
let selfTest = false;
let agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--check") {
    checkOnly = true;
  } else if (arg === "--apply") {
    applyPatch = true;
  } else if (arg === "--json") {
    jsonOutput = true;
  } else if (arg === "--self-test") {
    selfTest = true;
  } else if (arg === "--agent-dir") {
    agentDir = args[index + 1] || "";
    index += 1;
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else {
    console.error(`unknown option: ${arg}`);
    usage();
    process.exit(2);
  }
}

if (!checkOnly && !applyPatch) {
  checkOnly = true;
}
if (applyPatch) {
  checkOnly = false;
}

const FILE_SPECS = [
  {
    rel: "extensions/lib/commands/setup.ts",
    replacements: [
      {
        from: 'pi.sendUserMessage("Approved. Call `until_done_set` now and begin work.");',
        to: 'pi.sendUserMessage("Approved. Call `until_done_set` now and begin work.", { streamingBehavior: "followup" });',
      },
      {
        from: "pi.sendUserMessage(setupPrompt(intent));",
        to: 'pi.sendUserMessage(setupPrompt(intent), { streamingBehavior: "followup" });',
      },
    ],
  },
  {
    rel: "extensions/lib/commands/control.ts",
    replacements: [
      {
        from: `pi.sendUserMessage(
\t\tchallengingDone
\t\t\t? \`User has disputed the previous /until-done_complete. Resume work on goal: \${s.goal}. New evidence is required before re-completion.\`
\t\t\t: \`Resume work on the standing /until-done goal: \${s.goal}\`,
\t);`,
        to: `pi.sendUserMessage(
\t\tchallengingDone
\t\t\t? \`User has disputed the previous /until-done_complete. Resume work on goal: \${s.goal}. New evidence is required before re-completion.\`
\t\t\t: \`Resume work on the standing /until-done goal: \${s.goal}\`,
\t\t{ streamingBehavior: "followup" },
\t);`,
      },
    ],
  },
  {
    rel: "extensions/lib/commands/ask.ts",
    replacements: [
      {
        from: "pi.sendUserMessage(SIDE_QUESTION_PREFIX + question);",
        to: 'pi.sendUserMessage(SIDE_QUESTION_PREFIX + question, { streamingBehavior: "followup" });',
      },
    ],
  },
  {
    rel: "extensions/lib/hooks/agent-end-helpers.ts",
    replacements: [
      {
        from: `pi.sendUserMessage(cleanEndPrompt(store.state.northStar), {
\t\tdeliverAs: "followUp",
\t});`,
        to: `pi.sendUserMessage(cleanEndPrompt(store.state.northStar), {
\t\tdeliverAs: "followUp",
\t\tstreamingBehavior: "followup",
\t});`,
      },
      {
        from: 'pi.sendUserMessage(text, { deliverAs: "followUp" });',
        to: 'pi.sendUserMessage(text, { deliverAs: "followUp", streamingBehavior: "followup" });',
      },
    ],
  },
  {
    rel: "extensions/lib/hooks/tools.ts",
    replacements: [
      {
        from: '\t\tif (event.toolName.startsWith("until_done_")) return undefined;\n\t\tstore.progressSignalsThisTurn += 2;',
        to: '\t\tif (event.toolName.startsWith("until_done_")) {\n\t\t\tstore.progressSignalsThisTurn += 1;\n\t\t\treturn undefined;\n\t\t}\n\t\tstore.progressSignalsThisTurn += 2;',
      },
    ],
  },
];

function packageDirFor(rootAgentDir) {
  return path.join(rootAgentDir, "npm", "node_modules", PACKAGE_NAME);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function callExpressions(source, needle = "pi.sendUserMessage(") {
  const calls = [];
  let searchIndex = 0;
  while (true) {
    const start = source.indexOf(needle, searchIndex);
    if (start < 0) break;
    let index = start + needle.length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1] || "";

      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(start, index + 1));
          searchIndex = index + 1;
          break;
        }
      }
    }
    if (depth !== 0) {
      calls.push(source.slice(start));
      break;
    }
  }
  return calls;
}

function inspectPackage(pkgDir) {
  const pkgJson = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJson)) {
    return {
      schema: "pi67.pi-until-done-runtime-queue.v1",
      ok: true,
      status: "missing",
      packageDir: pkgDir,
      message: `${PACKAGE_NAME} is not installed; skipped runtime queue compatibility check`,
      files: [],
      missingStreamingBehavior: [],
    };
  }

  const pkg = readJson(pkgJson);
  const version = String(pkg.version || "");
  const files = [];
  const missingStreamingBehavior = [];
  const missingProgressSignals = [];
  const missingFiles = [];
  for (const spec of FILE_SPECS) {
    const file = path.join(pkgDir, spec.rel);
    if (!fs.existsSync(file)) {
      missingFiles.push(spec.rel);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    const calls = callExpressions(source);
    const missing = calls.filter((call) => !/\bstreamingBehavior\s*:/.test(call));
    const untilDoneProgressSignal =
      spec.rel === "extensions/lib/hooks/tools.ts"
        ? /\bevent\.toolName\.startsWith\("until_done_"\)[\s\S]{0,160}\bstore\.progressSignalsThisTurn\s*\+=\s*1\b/.test(source)
        : undefined;
    files.push({
      file: spec.rel,
      sendUserMessageCalls: calls.length,
      missingStreamingBehavior: missing.length,
      ...(untilDoneProgressSignal !== undefined ? { untilDoneProgressSignal } : {}),
    });
    if (untilDoneProgressSignal === false) {
      missingProgressSignals.push({
        file: spec.rel,
        reason: "until_done_* tool calls do not increment progressSignalsThisTurn",
      });
    }
    for (const call of missing) {
      missingStreamingBehavior.push({
        file: spec.rel,
        excerpt: call.replace(/\s+/g, " ").slice(0, 240),
      });
    }
  }

  const compatible =
    missingStreamingBehavior.length === 0 &&
    missingProgressSignals.length === 0 &&
    missingFiles.length === 0;
  let status = compatible ? "compatible" : "unpatched";
  let ok = compatible;
  let message = compatible
    ? `${PACKAGE_NAME}@${version} sendUserMessage calls include streamingBehavior and until_done_* tools count as progress`
    : `${PACKAGE_NAME}@${version} is missing queue/progress compatibility patches`;

  if (version !== EXPECTED_VERSION) {
    if (compatible) {
      status = "compatible_unexpected_version";
      ok = true;
      message = `${PACKAGE_NAME}@${version} appears queue/progress-compatible, but version is not ${EXPECTED_VERSION}`;
    } else {
      status = "review_required";
      ok = false;
      message = `${PACKAGE_NAME}@${version} is not ${EXPECTED_VERSION}; refusing automatic patch until reviewed`;
    }
  }

  return {
    schema: "pi67.pi-until-done-runtime-queue.v1",
    ok,
    status,
    packageDir: pkgDir,
    version,
    expectedVersion: EXPECTED_VERSION,
    message,
    files,
    missingFiles,
    missingStreamingBehavior,
    missingProgressSignals,
  };
}

function applyKnownPatch(pkgDir) {
  const before = inspectPackage(pkgDir);
  if (before.status === "missing") return before;
  if (before.version !== EXPECTED_VERSION) return before;

  const changedFiles = [];
  const skippedReplacements = [];
  for (const spec of FILE_SPECS) {
    const file = path.join(pkgDir, spec.rel);
    if (!fs.existsSync(file)) continue;
    let source = fs.readFileSync(file, "utf8");
    const original = source;
    for (const replacement of spec.replacements) {
      if (source.includes(replacement.to)) continue;
      if (source.includes(replacement.from)) {
        source = source.replace(replacement.from, replacement.to);
      } else {
        skippedReplacements.push({ file: spec.rel, pattern: replacement.from.slice(0, 120) });
      }
    }
    if (source !== original) {
      fs.writeFileSync(file, source, "utf8");
      changedFiles.push(spec.rel);
    }
  }

  const after = inspectPackage(pkgDir);
  return {
    ...after,
    changedFiles,
    skippedReplacements,
    message: after.ok
      ? `${PACKAGE_NAME}@${EXPECTED_VERSION} runtime queue/progress compatibility patch applied`
      : `${PACKAGE_NAME}@${EXPECTED_VERSION} runtime queue/progress compatibility patch incomplete`,
  };
}

function emit(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = result.ok ? "PASS" : result.status === "missing" ? "WARN" : "FAIL";
  console.log(`${label} ${result.message}`);
  if (result.changedFiles?.length) {
    console.log(`INFO changed files: ${result.changedFiles.join(", ")}`);
  }
  if (result.missingStreamingBehavior?.length) {
    for (const item of result.missingStreamingBehavior) {
      console.log(`WARN missing streamingBehavior: ${item.file}: ${item.excerpt}`);
    }
  }
  if (result.missingProgressSignals?.length) {
    for (const item of result.missingProgressSignals) {
      console.log(`WARN missing progress signal: ${item.file}: ${item.reason}`);
    }
  }
}

function makeSelfTestPackage(root) {
  const pkgDir = path.join(root, "agent", "npm", "node_modules", PACKAGE_NAME);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: EXPECTED_VERSION }, null, 2));
  for (const spec of FILE_SPECS) {
    const file = path.join(pkgDir, spec.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = spec.replacements.map((replacement) => replacement.from).join("\n\n");
    fs.writeFileSync(file, `${body}\n`, "utf8");
  }
  return path.join(root, "agent");
}

if (selfTest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-until-done-queue-test."));
  try {
    const tempAgent = makeSelfTestPackage(root);
    const pkgDir = packageDirFor(tempAgent);
    const first = inspectPackage(pkgDir);
    if (first.ok || first.status !== "unpatched") throw new Error(`expected unpatched self-test package, got ${first.status}`);
    const patched = applyKnownPatch(pkgDir);
    if (!patched.ok) throw new Error(`patch did not make package compatible: ${patched.message}`);
    const second = applyKnownPatch(pkgDir);
    if (!second.ok) throw new Error(`idempotent patch check failed: ${second.message}`);
    console.log("pi-until-done runtime queue/progress patch self-test passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

const pkgDir = packageDirFor(path.resolve(agentDir || REPO_ROOT));
const result = applyPatch ? applyKnownPatch(pkgDir) : inspectPackage(pkgDir);
emit(result);
process.exit(result.ok ? 0 : 1);
