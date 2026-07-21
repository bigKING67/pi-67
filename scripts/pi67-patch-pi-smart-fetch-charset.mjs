#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_NAME = "pi-smart-fetch";
const EXPECTED_VERSION = "0.3.12";
const DIST_REL = "dist/index.js";
const PATCH_MARKER = "pi67-smart-fetch-charset-v1";
const REVIEW_REQUIRED_EXIT_CODE = 3;

const IMPORT_ANCHOR = "import { parseHTML } from 'linkedom';";
const ICONV_IMPORT = "import iconv from 'iconv-lite';";
const NORMALIZE_CONTENT_TYPE = `function normalizeContentType(contentType) {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}`;
const RAW_BODY_READ = "const rawBody = await response.text();";
const PATCHED_BODY_READ = "const rawBody = await decodeTextResponse(response, contentType);";
const CHARSET_DECODER = `
// ${PATCH_MARKER}: response.text() always assumes UTF-8 and corrupts GBK/GB2312 pages.
function responseCharset(contentType) {
  const match = contentType.match(/charset\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^;\\s]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase();
}
async function decodeTextResponse(response, contentType) {
  const charset = responseCharset(contentType);
  if (!charset || /^(?:utf-?8|us-ascii)$/.test(charset) || !iconv.encodingExists(charset) || typeof response.arrayBuffer !== "function") {
    return response.text();
  }
  return iconv.decode(Buffer.from(await response.arrayBuffer()), charset);
}`;

function usage() {
  console.log(`pi67-patch-pi-smart-fetch-charset

Usage:
  node scripts/pi67-patch-pi-smart-fetch-charset.mjs [--check] [--apply] [--json] [--agent-dir DIR]
  node scripts/pi67-patch-pi-smart-fetch-charset.mjs --self-test

The patch is version-aware. It only changes pi-smart-fetch@${EXPECTED_VERSION},
whose response.text() path decodes every textual response as UTF-8 even when
Content-Type declares GBK, GB2312, or another iconv-lite encoding.`);
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

if (!checkOnly && !applyPatch) checkOnly = true;
if (applyPatch) checkOnly = false;

function packageDirFor(rootAgentDir) {
  return path.join(rootAgentDir, "npm", "node_modules", PACKAGE_NAME);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function canResolveIconvLite(distFile) {
  try {
    createRequire(distFile).resolve("iconv-lite");
    return true;
  } catch {
    return false;
  }
}

function inspectPackage(pkgDir) {
  const packageFile = path.join(pkgDir, "package.json");
  if (!fs.existsSync(packageFile)) {
    return {
      schema: "pi67.pi-smart-fetch-charset.v1",
      ok: true,
      status: "missing",
      packageDir: pkgDir,
      message: `${PACKAGE_NAME} is not installed; skipped charset compatibility check`,
    };
  }

  const version = String(readJson(packageFile).version || "");
  const distFile = path.join(pkgDir, DIST_REL);
  if (!fs.existsSync(distFile)) {
    return {
      schema: "pi67.pi-smart-fetch-charset.v1",
      ok: false,
      status: "review_required",
      packageDir: pkgDir,
      version,
      expectedVersion: EXPECTED_VERSION,
      message: `${PACKAGE_NAME}@${version} is missing ${DIST_REL}`,
    };
  }

  const source = fs.readFileSync(distFile, "utf8");
  const iconvAvailable = canResolveIconvLite(distFile);
  const compatible = source.includes(PATCH_MARKER) &&
    source.includes(ICONV_IMPORT) &&
    source.includes(PATCHED_BODY_READ);
  if (compatible) {
    if (!iconvAvailable) {
      return {
        schema: "pi67.pi-smart-fetch-charset.v1",
        ok: false,
        status: "review_required",
        packageDir: pkgDir,
        version,
        expectedVersion: EXPECTED_VERSION,
        message: `${PACKAGE_NAME}@${version} charset patch is present but iconv-lite cannot be resolved; run npm sync before loading the extension`,
      };
    }
    return {
      schema: "pi67.pi-smart-fetch-charset.v1",
      ok: true,
      status: version === EXPECTED_VERSION ? "compatible" : "compatible_unexpected_version",
      packageDir: pkgDir,
      version,
      expectedVersion: EXPECTED_VERSION,
      message: `${PACKAGE_NAME}@${version} decodes declared non-UTF-8 response charsets`,
    };
  }

  const patchable = source.includes(IMPORT_ANCHOR) &&
    source.includes(NORMALIZE_CONTENT_TYPE) &&
    source.includes(RAW_BODY_READ);
  if (version !== EXPECTED_VERSION || !patchable) {
    return {
      schema: "pi67.pi-smart-fetch-charset.v1",
      ok: false,
      status: "review_required",
      packageDir: pkgDir,
      version,
      expectedVersion: EXPECTED_VERSION,
      message: `${PACKAGE_NAME}@${version} charset path differs from the reviewed ${EXPECTED_VERSION} bundle; refusing automatic patch`,
    };
  }

  if (!iconvAvailable) {
    return {
      schema: "pi67.pi-smart-fetch-charset.v1",
      ok: false,
      status: "review_required",
      packageDir: pkgDir,
      version,
      expectedVersion: EXPECTED_VERSION,
      message: `${PACKAGE_NAME}@${version} needs iconv-lite before the charset patch can be applied; run npm sync first`,
    };
  }

  return {
    schema: "pi67.pi-smart-fetch-charset.v1",
    ok: false,
    status: "unpatched",
    packageDir: pkgDir,
    version,
    expectedVersion: EXPECTED_VERSION,
    message: `${PACKAGE_NAME}@${version} still decodes all textual responses as UTF-8`,
  };
}

function applyKnownPatch(pkgDir) {
  const before = inspectPackage(pkgDir);
  if (before.status === "missing" || before.ok || before.status === "review_required") return before;

  const distFile = path.join(pkgDir, DIST_REL);
  const source = fs.readFileSync(distFile, "utf8");
  const patched = source
    .replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${ICONV_IMPORT}`)
    .replace(NORMALIZE_CONTENT_TYPE, `${NORMALIZE_CONTENT_TYPE}${CHARSET_DECODER}`)
    .replace(RAW_BODY_READ, PATCHED_BODY_READ);
  fs.writeFileSync(distFile, patched, "utf8");

  const after = inspectPackage(pkgDir);
  if (!after.ok) {
    fs.writeFileSync(distFile, source, "utf8");
  }
  return {
    ...after,
    changedFiles: after.ok ? [DIST_REL] : [],
    message: after.ok
      ? `${PACKAGE_NAME}@${EXPECTED_VERSION} charset compatibility patch applied`
      : `${PACKAGE_NAME}@${EXPECTED_VERSION} charset compatibility patch incomplete`,
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
}

function makeSelfTestPackage(root, version = EXPECTED_VERSION, includeIconv = true) {
  const pkgDir = packageDirFor(path.join(root, "agent"));
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  if (includeIconv) {
    const iconvDir = path.join(pkgDir, "..", "iconv-lite");
    fs.mkdirSync(iconvDir, { recursive: true });
    fs.writeFileSync(
      path.join(iconvDir, "package.json"),
      JSON.stringify({ name: "iconv-lite", version: "0.0.0-self-test", main: "index.js" }, null, 2),
    );
    fs.writeFileSync(path.join(iconvDir, "index.js"), "module.exports = {};\n", "utf8");
  }
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version }, null, 2),
  );
  fs.writeFileSync(
    path.join(pkgDir, DIST_REL),
    `${IMPORT_ANCHOR}\n\n${NORMALIZE_CONTENT_TYPE}\n\nasync function fetchPage(response, contentType) {\n  ${RAW_BODY_READ}\n  return rawBody;\n}\n`,
    "utf8",
  );
  return path.join(root, "agent");
}

if (selfTest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-smart-fetch-charset-test."));
  try {
    const tempAgent = makeSelfTestPackage(root);
    const pkgDir = packageDirFor(tempAgent);
    const first = inspectPackage(pkgDir);
    if (first.ok || first.status !== "unpatched") {
      throw new Error(`expected unpatched self-test package, got ${first.status}`);
    }
    const patched = applyKnownPatch(pkgDir);
    if (!patched.ok) throw new Error(`patch did not make package compatible: ${patched.message}`);
    const source = fs.readFileSync(path.join(pkgDir, DIST_REL), "utf8");
    if (!source.includes("iconv.decode(Buffer.from(await response.arrayBuffer()), charset)")) {
      throw new Error("patched decoder does not use the original response bytes");
    }
    const second = applyKnownPatch(pkgDir);
    if (!second.ok || second.changedFiles?.length) {
      throw new Error(`idempotent patch check failed: ${second.message}`);
    }

    const reviewAgent = makeSelfTestPackage(path.join(root, "review"), "9.9.9");
    const review = applyKnownPatch(packageDirFor(reviewAgent));
    if (review.ok || review.status !== "review_required" || review.changedFiles?.length) {
      throw new Error(`unexpected-version package was not rejected safely: ${review.message}`);
    }

    const missingDepAgent = makeSelfTestPackage(path.join(root, "missing-dep"), EXPECTED_VERSION, false);
    const missingDepDir = packageDirFor(missingDepAgent);
    const missingDepSource = fs.readFileSync(path.join(missingDepDir, DIST_REL), "utf8");
    const missingDep = applyKnownPatch(missingDepDir);
    if (missingDep.ok || missingDep.status !== "review_required" || missingDep.changedFiles?.length) {
      throw new Error(`missing iconv-lite dependency was not rejected safely: ${missingDep.message}`);
    }
    if (fs.readFileSync(path.join(missingDepDir, DIST_REL), "utf8") !== missingDepSource) {
      throw new Error("missing-dependency package was modified before review");
    }
    console.log("pi-smart-fetch charset patch self-test passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

const pkgDir = packageDirFor(path.resolve(agentDir || REPO_ROOT));
const result = applyPatch ? applyKnownPatch(pkgDir) : inspectPackage(pkgDir);
emit(result);
process.exit(result.ok ? 0 : result.status === "review_required" ? REVIEW_REQUIRED_EXIT_CODE : 1);
