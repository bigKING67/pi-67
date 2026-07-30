#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPhysicalPiCodingAgentPackages } from "../packages/pi67-cli/src/lib/managed-extensions.mjs";

const EXPECTED = Object.freeze({
  typeHost: "0.80.6",
  ajv: "8.20.0",
  typescript: "5.9.3",
});

export function inspectDependencyClosure(repoRoot) {
  const root = path.resolve(repoRoot);
  const npmRoot = path.join(root, "npm");
  const rootPackage = readJson(path.join(root, "package.json"));
  const npmPackage = readJson(path.join(npmRoot, "package.json"));
  const rootLock = readJson(path.join(root, "package-lock.json"));
  const npmLock = readJson(path.join(npmRoot, "package-lock.json"));
  const physical = findPhysicalPiCodingAgentPackages(npmRoot).map((packageRoot) => {
    const pkg = readJson(path.join(packageRoot, "package.json"));
    return {
      name: pkg.name || "",
      version: pkg.version || "",
      path: normalizeRelative(root, packageRoot),
    };
  });
  const expectedTypeHostPath = "npm/node_modules/@earendil-works/pi-coding-agent";
  const problems = [];

  checkDirectVersion(problems, "root package", rootPackage.devDependencies, "@earendil-works/pi-coding-agent", EXPECTED.typeHost);
  checkDirectVersion(problems, "npm package", npmPackage.devDependencies, "@earendil-works/pi-coding-agent", EXPECTED.typeHost);
  checkDirectVersion(problems, "root package", rootPackage.devDependencies, "ajv", EXPECTED.ajv);
  checkDirectVersion(problems, "npm package", npmPackage.devDependencies, "ajv", EXPECTED.ajv);
  checkDirectVersion(problems, "root package", rootPackage.devDependencies, "typescript", EXPECTED.typescript);
  checkDirectVersion(problems, "npm package", npmPackage.devDependencies, "typescript", EXPECTED.typescript);
  checkLock(problems, "root lock", rootLock, EXPECTED);
  checkLock(problems, "npm lock", npmLock, EXPECTED);

  if (physical.length !== 1) {
    problems.push(`expected exactly one physical Pi type host, found ${physical.length}`);
  }
  const typeHost = physical[0];
  if (typeHost && (
    typeHost.name !== "@earendil-works/pi-coding-agent"
    || typeHost.version !== EXPECTED.typeHost
    || typeHost.path !== expectedTypeHostPath
  )) {
    problems.push(
      `unexpected physical Pi runtime ${typeHost.name || "unknown"}@${typeHost.version || "unknown"} at ${typeHost.path}`,
    );
  }

  for (const configName of ["tsconfig.xtalpi.json", "tsconfig.hy-memory.json"]) {
    const config = readJson(path.join(root, configName));
    const paths = config.compilerOptions?.paths || {};
    const hostMapping = paths["@earendil-works/pi-coding-agent"];
    const sdkMapping = paths["@earendil-works/*"];
    if (!Array.isArray(hostMapping) || hostMapping.length !== 1 || hostMapping[0] !== expectedTypeHostPath) {
      problems.push(`${configName} must resolve the Pi host from ${expectedTypeHostPath}`);
    }
    const expectedSdkPath = `${expectedTypeHostPath}/node_modules/@earendil-works/*`;
    if (!Array.isArray(sdkMapping) || sdkMapping.length !== 1 || sdkMapping[0] !== expectedSdkPath) {
      problems.push(`${configName} must resolve Pi SDK packages from ${expectedSdkPath}`);
    }
  }

  return {
    schema: "pi67.dependency-closure.v1",
    ok: problems.length === 0,
    expected: EXPECTED,
    physicalPiPackages: physical,
    problems,
  };
}

export function assertDependencyClosure(report) {
  if (!report.ok) {
    throw new Error(`dependency closure is invalid:\n- ${report.problems.join("\n- ")}`);
  }
  return report;
}

function checkDirectVersion(problems, label, dependencies, packageName, expectedVersion) {
  const actual = dependencies?.[packageName];
  if (actual !== expectedVersion) {
    problems.push(`${label} must declare ${packageName}@${expectedVersion} directly, got ${actual || "missing"}`);
  }
}

function checkLock(problems, label, lock, expected) {
  const root = lock.packages?.[""];
  checkDirectVersion(problems, label, root?.devDependencies, "@earendil-works/pi-coding-agent", expected.typeHost);
  checkDirectVersion(problems, label, root?.devDependencies, "ajv", expected.ajv);
  checkDirectVersion(problems, label, root?.devDependencies, "typescript", expected.typescript);
  checkLockedPackage(problems, label, lock, "@earendil-works/pi-coding-agent", expected.typeHost);
  checkLockedPackage(problems, label, lock, "ajv", expected.ajv);
  checkLockedPackage(problems, label, lock, "typescript", expected.typescript);
}

function checkLockedPackage(problems, label, lock, packageName, expectedVersion) {
  const entry = lock.packages?.[`node_modules/${packageName}`];
  // npm omits `dev: true` when a direct dev dependency also satisfies a
  // production dependency's peer range. The root declaration remains the
  // ownership source; the locked package itself must be exact and non-peer.
  if (entry?.version !== expectedVersion || entry.peer === true) {
    problems.push(`${label} must lock direct dev dependency ${packageName}@${expectedVersion}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function parseArgs(argv) {
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--repo-root") repoRoot = path.resolve(argv[++index] || "");
    else if (arg === "-h" || arg === "--help") return { help: true, json, repoRoot };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { help: false, json, repoRoot };
}

function printHelp() {
  process.stdout.write(`pi-67 dependency closure check

Usage:
  node scripts/pi67-dependency-closure-check.mjs [--repo-root <path>] [--json]

Requires one repository-local Pi 0.80.6 type host and rejects physical nested
or legacy Pi runtimes. This check does not inspect or modify the global Pi runtime.
`);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const report = inspectDependencyClosure(options.repoRoot);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (report.ok) process.stdout.write(`PASS dependency closure: ${report.physicalPiPackages[0].name}@${report.physicalPiPackages[0].version}\n`);
  else process.stderr.write(`FAIL dependency closure:\n- ${report.problems.join("\n- ")}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}
