import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageFile = path.join(repoRoot, "package.json");
const tsconfigFile = path.join(repoRoot, "tsconfig.xtalpi.json");
const ciFile = path.join(repoRoot, ".github", "workflows", "ci.yml");
const legacyTestFile = path.join(repoRoot, "scripts", "pi67-test-xtalpi-pi-tools.sh");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requiredScript(scripts, name) {
  const script = scripts[name];
  assert.equal(typeof script, "string", `package.json missing script ${name}`);
  assert.ok(script.trim(), `package.json script ${name} is empty`);
  return script;
}

function coverageFloor(script, metric) {
  const match = script.match(new RegExp(`--test-coverage-${metric}=(\\d+(?:\\.\\d+)?)\\b`));
  assert.ok(match, `test:xtalpi:coverage is missing the ${metric} floor`);
  return Number(match[1]);
}

test("xtalpi package scripts pin strict typecheck and coverage gates", () => {
  const pkg = readJson(packageFile);
  const scripts = pkg.scripts ?? {};
  const typecheck = requiredScript(scripts, "typecheck:xtalpi");
  requiredScript(scripts, "test:xtalpi");
  requiredScript(scripts, "test:xtalpi:node");
  const coverage = requiredScript(scripts, "test:xtalpi:coverage");

  assert.match(typecheck, /--project tsconfig\.xtalpi\.json\b/);
  assert.equal(pkg.devDependencies?.typescript, "5.9.3");
  assert.ok(coverageFloor(coverage, "lines") >= 93);
  assert.ok(coverageFloor(coverage, "branches") >= 85);
  assert.ok(coverageFloor(coverage, "functions") >= 95);
});

test("xtalpi strict compiler and cross-platform CI contracts stay enabled", () => {
  const tsconfig = readJson(tsconfigFile);
  assert.equal(tsconfig.compilerOptions?.strict, true);
  assert.equal(tsconfig.compilerOptions?.exactOptionalPropertyTypes, true);
  assert.equal(tsconfig.compilerOptions?.noUncheckedIndexedAccess, true);

  const ci = fs.readFileSync(ciFile, "utf8");
  assert.ok((ci.match(/npm run -s typecheck:xtalpi/g) ?? []).length >= 2);
  assert.ok((ci.match(/npm run -s test:xtalpi:coverage/g) ?? []).length >= 2);
});

test("legacy xtalpi shell regression suite stays below its migration budget", () => {
  const physicalLines = fs.readFileSync(legacyTestFile, "utf8").split(/\r?\n/).length;
  assert.ok(
    physicalLines <= 1900,
    `pi67-test-xtalpi-pi-tools.sh has ${physicalLines} lines; migrate focused cases to Node test files`,
  );
});
