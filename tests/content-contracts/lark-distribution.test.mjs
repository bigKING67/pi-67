import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED_SKILLS = path.join(ROOT, "shared-skills");
const SLIDES_ROOT = path.join(SHARED_SKILLS, "lark-slides");

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function larkFiles() {
  return readdirSync(SHARED_SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("lark-"))
    .flatMap((entry) => walkFiles(path.join(SHARED_SKILLS, entry.name)));
}

function runPython(source, files) {
  return spawnSync("python3", ["-c", source, ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("bundled Lark content is not an HTML error response", () => {
  const checkedExtensions = new Set([".json", ".md", ".py", ".xml"]);
  const offenders = [];

  for (const file of larkFiles()) {
    if (!checkedExtensions.has(path.extname(file))) continue;
    const content = readFileSync(file, "utf8");
    if (/^\s*<!doctype\s+html/i.test(content) || /^\s*<html(?:\s|>)/i.test(content)) {
      offenders.push(relative(file));
    }
  }

  assert.deepEqual(offenders, []);
});

test("bundled Lark Python helpers parse without writing pyc files", () => {
  const files = larkFiles().filter((file) => file.endsWith(".py"));
  const source = [
    "import ast, pathlib, sys",
    "for name in sys.argv[1:]:",
    "    path = pathlib.Path(name)",
    "    ast.parse(path.read_text(encoding='utf-8'), filename=str(path))",
  ].join("\n");
  const result = runPython(source, files);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Slides template index, catalog, files, and XML roots agree", () => {
  const templateRoot = path.join(SLIDES_ROOT, "assets/templates");
  const indexPath = path.join(SLIDES_ROOT, "references/template-index.json");
  const catalogPath = path.join(SLIDES_ROOT, "references/template-catalog.md");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const indexedIds = new Set(index.templates.map((entry) => entry.template_id));
  const xmlFiles = walkFiles(templateRoot).filter((file) => file.endsWith(".xml"));
  const xmlIds = new Set(xmlFiles.map((file) => path.basename(file, ".xml")));

  assert.equal(index.template_count, index.templates.length);
  assert.deepEqual([...indexedIds].sort(), [...xmlIds].sort());

  const catalog = readFileSync(catalogPath, "utf8");
  const catalogIds = new Set(
    [...catalog.matchAll(/`([a-z][a-z0-9-]*--[a-z0-9_]+)`/g)].map((match) => match[1]),
  );
  for (const id of catalogIds) {
    assert.ok(xmlIds.has(id), `catalog references missing template: ${id}`);
  }

  const source = [
    "import sys, xml.etree.ElementTree as ET",
    "for name in sys.argv[1:]:",
    "    root = ET.parse(name).getroot()",
    "    if root.tag.rsplit('}', 1)[-1] != 'presentation':",
    "        raise SystemExit(f'{name}: unexpected root {root.tag}')",
  ].join("\n");
  const result = runPython(source, xmlFiles);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("scraping docs and templates use the current browser67 contract", () => {
  const roots = [path.join(ROOT, "docs"), path.join(ROOT, "templates/scrapers")];
  const files = roots.flatMap(walkFiles).filter((file) => /\.(?:js|md)$/.test(file));
  const staleNames = ["browser_background_task", "browser_paginate", "browser_interact"];
  const offenders = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const name of staleNames) {
      if (content.includes(name)) offenders.push(`${relative(file)}: ${name}`);
    }
    if (/browser_execute_js\s*\(\s*\{\s*code\s*:/s.test(content)) {
      offenders.push(`${relative(file)}: browser_execute_js.code`);
    }
    if (/browser_job_ops\s*\(\s*\{\s*code\s*:/s.test(content)) {
      offenders.push(`${relative(file)}: browser_job_ops.code`);
    }
  }

  assert.deepEqual(offenders, []);

  const guide = readFileSync(path.join(ROOT, "docs/scraping-guide.md"), "utf8");
  assert.match(guide, /browser_job_ops/);
  assert.match(guide, /browser_wait/);
  assert.match(guide, /durable:true/);
  assert.match(guide, /abort_supported/);
});

test("paginated scraper resolves a bounded job and preserves invalid checkpoints", async () => {
  const templatePath = path.join(ROOT, "templates/scrapers/paginated_table_scrape.js");
  const source = readFileSync(templatePath, "utf8").replace("totalPages: 200", "totalPages: 1");
  const row = { textContent: "row-1" };
  const header = { textContent: "header" };
  const pager = {
    classList: { contains: (name) => name === "content-ecom-pager-item-checked" },
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    textContent: "1",
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === ".content-ecom-Table-Row") return [header, row];
      if (selector === ".content-ecom-pager-item") return [pager];
      return [];
    },
  };
  const storage = {};
  const result = await vm.runInNewContext(source, {
    console: { error() {}, log() {} },
    document,
    EXTRACT_FN: () => ({ _dedupKey: "row-1", value: "ok" }),
    localStorage: storage,
    setTimeout,
  });

  assert.equal(result.status, "done");
  assert.equal(result.pages_completed, 1);
  assert.equal(JSON.parse(storage._paginated_scrape).data.length, 1);
  assert.equal(storage._paginated_scrape_done, "1");

  const invalidStorage = { _paginated_scrape: "{}" };
  const invalidResult = await vm.runInNewContext(source, {
    console: { error() {}, log() {} },
    document,
    EXTRACT_FN: () => ({ _dedupKey: "row-1" }),
    localStorage: invalidStorage,
    setTimeout,
  });
  assert.equal(invalidResult.status, "failed");
  assert.equal(invalidResult.error, "invalid_checkpoint");
  assert.equal(invalidStorage._paginated_scrape, "{}");
});

test("network hook template fails closed on an invalid checkpoint", () => {
  const source = readFileSync(
    path.join(ROOT, "templates/scrapers/network_hook_collect.js"),
    "utf8",
  );
  const storage = { _network_hook_collect: "{}" };
  const result = vm.runInNewContext(source, {
    console: { error() {}, log() {} },
    localStorage: storage,
  });

  assert.equal(result.checkpoint_valid, false);
  assert.equal(result.hooks_installed, 0);
  assert.equal(storage._network_hook_collect, "{}");
  assert.match(storage._network_hook_collect_errors, /load_checkpoint/);
});

test("npm README does not pin a stale release candidate", () => {
  const readme = readFileSync(path.join(ROOT, "packages/pi67-cli/README.md"), "utf8");
  assert.doesNotMatch(readme, /release candidate/i);
  assert.doesNotMatch(readme, /@bigking67\/pi-67@\d/);
  assert.doesNotMatch(readme, /^Version:\s*`/m);
  assert.match(readme, /npm install --global @bigking67\/pi-67(?:\r?\n|$)/);
});

test("declared MIT license has a repository license file", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const packageMetadata = JSON.parse(
    readFileSync(path.join(ROOT, "packages/pi67-cli/package.json"), "utf8"),
  );
  const licensePath = path.join(ROOT, "LICENSE");

  if (/`LICENSE`/.test(readme) || packageMetadata.license === "MIT") {
    assert.ok(existsSync(licensePath), "README/package metadata declares a missing LICENSE");
    const license = readFileSync(licensePath, "utf8");
    assert.match(license, /^MIT License$/m);
    assert.match(license, /Permission is hereby granted, free of charge/);
  }
});
