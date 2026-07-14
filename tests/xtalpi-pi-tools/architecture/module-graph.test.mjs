import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL(
  "../../../extensions/xtalpi-pi-tools/",
  import.meta.url,
));

function listTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
    })
    .sort();
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    /\bimport\s+["'](\.[^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)].sort();
}

function buildModuleGraph() {
  const files = listTypeScriptFiles(extensionRoot);
  const fileSet = new Set(files);
  const graph = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const dependencies = relativeImportSpecifiers(source).map((specifier) => {
      assert.ok(specifier.endsWith(".ts"), `${path.relative(extensionRoot, file)} must use an explicit .ts import: ${specifier}`);
      const resolved = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(extensionRoot, resolved);
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${specifier} escapes xtalpi-pi-tools`);
      assert.ok(fileSet.has(resolved), `${path.relative(extensionRoot, file)} imports missing module ${specifier}`);
      return resolved;
    });
    graph.set(file, dependencies);
  }

  return graph;
}

function findCycle(graph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      return [...stack.slice(start), file];
    }
    if (visited.has(file)) return undefined;

    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
    return undefined;
  }

  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return undefined;
}

test("xtalpi TypeScript module graph is local, explicit, and acyclic", () => {
  const graph = buildModuleGraph();
  const cycle = findCycle(graph);
  assert.equal(
    cycle,
    undefined,
    cycle?.map((file) => path.relative(extensionRoot, file)).join(" -> "),
  );
  assert.ok(graph.size >= 40, "architecture audit unexpectedly found too few xtalpi modules");
});

test("provider turn orchestration stays below the monolith regression limit", () => {
  const providerTurn = path.join(extensionRoot, "provider-turn.ts");
  const physicalLines = fs.readFileSync(providerTurn, "utf8").split(/\r?\n/).length;
  assert.ok(
    physicalLines <= 400,
    `provider-turn.ts has ${physicalLines} lines; move preparation or policy logic into turn/ modules`,
  );
});

test("retry compatibility facade has no active runtime importers", () => {
  const retryFacade = path.join(extensionRoot, "retry.ts");
  const importers = listTypeScriptFiles(extensionRoot)
    .filter((file) => file !== retryFacade)
    .filter((file) => /(?:from\s+|import\s*\()["'][^"']*retry\.ts["']/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(extensionRoot, file));

  assert.deepEqual(importers, []);
  const source = fs.readFileSync(retryFacade, "utf8");
  assert.match(source, /export\s*\{[\s\S]*\}\s*from\s*["']\.\/config\/legacy-runtime-env\.ts["']/);
  assert.match(source, /export\s*\{[\s\S]*\}\s*from\s*["']\.\/turn\/recovery-prompts\.ts["']/);
  assert.ok(source.split(/\r?\n/).length <= 30, "retry.ts must remain a small compatibility facade");
});
