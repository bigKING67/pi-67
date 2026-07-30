import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyManagedExtensionBaselines,
  findPhysicalPiCodingAgentPackages,
  inspectManagedExtensions,
  planNpmBaselineInstall,
  readManagedExtensionBaselines,
} from "../../packages/pi67-cli/src/lib/managed-extensions.mjs";
import { hashDirectory } from "../../packages/pi67-cli/src/lib/skill-pack-integrity.mjs";

test("fresh npm baselines use one peer-omitting batch, patch each entry, and reuse a no-op inspection", () => {
  const fixture = createFixture();
  try {
    const sharedRuntime = { "fixture-runtime": "2.0.0" };
    const entries = [
      fixtureEntry(fixture, {
        id: "pi-until-done",
        packageName: "fixture-until-done",
        version: "1.0.0",
        runtimeDependencies: sharedRuntime,
      }),
      fixtureEntry(fixture, {
        id: "pi-smart-fetch",
        packageName: "fixture-smart-fetch",
        version: "2.0.0",
        runtimeDependencies: sharedRuntime,
      }),
    ];
    const registry = fixtureRegistry(entries);
    writePatchers(fixture.sourceRoot);

    const calls = [];
    const result = applyManagedExtensionBaselines(fixture.ctx, {
      registry,
      sourceRoot: fixture.sourceRoot,
      commandRunner(command, args, options = {}) {
        calls.push({ command, args: [...args], cwd: options.cwd || "" });
        if (command === "npm") installFixtureClosure(fixture, entries);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    const npmCalls = calls.filter((call) => call.command === "npm");
    const patchCalls = calls.filter((call) => call.command === process.execPath);
    assert.equal(npmCalls.length, 1);
    assert.deepEqual(npmCalls[0].args.slice(0, 6), [
      "install",
      "--save-exact",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    assert.deepEqual(npmCalls[0].args.slice(6), [
      "fixture-until-done@1.0.0",
      "fixture-smart-fetch@2.0.0",
      "fixture-runtime@2.0.0",
    ]);
    assert.equal(patchCalls.length, 2);
    assert.ok(patchCalls.every((call) => call.args.includes("--apply")));
    assert.deepEqual(result.applied.map((entry) => entry.id), ["pi-until-done", "pi-smart-fetch"]);
    assert.equal(result.after.summary.atBaseline, 2);
    assert.ok(result.after.extensions.every((entry) => entry.runtimeDependencyClosure.ready));
    assert.deepEqual(findPhysicalPiCodingAgentPackages(path.join(fixture.ctx.agentDir, "npm")), []);

    const ledgerPath = path.join(fixture.ctx.stateDir, "extension-ledger.json");
    const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
    let inspections = 0;
    const noOp = applyManagedExtensionBaselines(fixture.ctx, {
      registry,
      sourceRoot: fixture.sourceRoot,
      inspect(ctx, options) {
        inspections += 1;
        return inspectManagedExtensions(ctx, options);
      },
      commandRunner() {
        throw new Error("no-op apply must not invoke a command");
      },
    });
    assert.equal(inspections, 1);
    assert.deepEqual(noOp.applied, []);
    assert.strictEqual(noOp.after, noOp.before);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
  } finally {
    fixture.cleanup();
  }
});

test("npm batch planning rejects conflicting runtime dependencies and host Pi packages before writing", () => {
  const ctx = { agentDir: path.join(os.tmpdir(), "pi67-plan-only") };
  assert.throws(
    () => planNpmBaselineInstall(ctx, [
      npmEntry("one", "fixture-one", "1.0.0", { "fixture-runtime": "1.0.0" }),
      npmEntry("two", "fixture-two", "1.0.0", { "fixture-runtime": "2.0.0" }),
    ]),
    /conflicting versions of fixture-runtime/,
  );
  assert.throws(
    () => planNpmBaselineInstall(ctx, [
      npmEntry("bad-host", "fixture-extension", "1.0.0", {
        "@earendil-works/pi-coding-agent": "0.80.6",
      }),
    ]),
    /must use the host Pi runtime/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-managed-registry-conflict-"));
  try {
    const registryFile = path.join(root, "baselines.json");
    fs.writeFileSync(registryFile, `${JSON.stringify(fixtureRegistry([
      npmEntry("one", "fixture-one", "1.0.0", { "fixture-runtime": "1.0.0" }),
      npmEntry("two", "fixture-two", "1.0.0", { "fixture-runtime": "2.0.0" }),
    ]))}\n`);
    assert.throws(() => readManagedExtensionBaselines(registryFile), /conflicting versions of fixture-runtime/);
    fs.writeFileSync(registryFile, `${JSON.stringify(fixtureRegistry([{
      id: "fixture-bundled",
      sourceKind: "bundled",
      bundlePath: "extensions/fixture-bundled",
      minimumVersion: "1.0.0",
      contentHash: "a".repeat(64),
    }]))}\n`);
    assert.throws(() => readManagedExtensionBaselines(registryFile), /contentRevision/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed batch and detected nested Pi runtimes never write the extension ledger", () => {
  for (const mode of ["command-failure", "nested-runtime"]) {
    const fixture = createFixture();
    try {
      const entry = fixtureEntry(fixture, {
        id: `fixture-${mode}`,
        packageName: `fixture-${mode}`,
        version: "1.0.0",
      });
      const registry = fixtureRegistry([entry]);
      const ledgerPath = path.join(fixture.ctx.stateDir, "extension-ledger.json");
      fs.mkdirSync(fixture.ctx.stateDir, { recursive: true });
      const originalLedger = '{"schema":"pi67.extension-ledger.v1","updatedAt":"fixed","extensions":{}}\n';
      fs.writeFileSync(ledgerPath, originalLedger);

      assert.throws(
        () => applyManagedExtensionBaselines(fixture.ctx, {
          registry,
          sourceRoot: fixture.sourceRoot,
          commandRunner(command) {
            if (command !== "npm") return { status: 0, stdout: "", stderr: "" };
            if (mode === "command-failure") {
              const partial = path.join(
                fixture.ctx.agentDir,
                "npm",
                "node_modules",
                "@earendil-works",
                "pi-coding-agent",
              );
              fs.mkdirSync(partial, { recursive: true });
              throw new Error("injected npm failure");
            }
            installFixtureClosure(fixture, [entry]);
            const nested = path.join(
              fixture.ctx.agentDir,
              "npm",
              "node_modules",
              entry.packageName,
              "node_modules",
              "@mariozechner",
              "pi-coding-agent",
            );
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(nested, "package.json"), '{"name":"@mariozechner/pi-coding-agent","version":"0.73.1"}\n');
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
        mode === "command-failure" ? /injected npm failure/ : /parallel Pi runtime/,
      );
      assert.equal(fs.readFileSync(ledgerPath, "utf8"), originalLedger);
      assert.deepEqual(findPhysicalPiCodingAgentPackages(path.join(fixture.ctx.agentDir, "npm")), []);
    } finally {
      fixture.cleanup();
    }
  }
});

test("pre-existing Pi runtimes block npm mutation without rewriting the ledger", () => {
  const fixture = createFixture();
  try {
    const entry = fixtureEntry(fixture, {
      id: "fixture-pre-existing-runtime",
      packageName: "fixture-pre-existing-runtime",
      version: "1.0.0",
    });
    const registry = fixtureRegistry([entry]);
    const existing = path.join(
      fixture.ctx.agentDir,
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(existing, { recursive: true });
    const ledgerPath = path.join(fixture.ctx.stateDir, "extension-ledger.json");
    fs.mkdirSync(fixture.ctx.stateDir, { recursive: true });
    const originalLedger = '{"schema":"pi67.extension-ledger.v1","updatedAt":"fixed","extensions":{}}\n';
    fs.writeFileSync(ledgerPath, originalLedger);
    let commandCalled = false;

    assert.throws(
      () => applyManagedExtensionBaselines(fixture.ctx, {
        registry,
        sourceRoot: fixture.sourceRoot,
        commandRunner() {
          commandCalled = true;
          throw new Error("must not run");
        },
      }),
      /parallel Pi runtime before managed extension installation/,
    );
    assert.equal(commandCalled, false);
    assert.equal(fs.existsSync(existing), true);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), originalLedger);
  } finally {
    fixture.cleanup();
  }
});

test("managed Git extension dependencies omit dev and peers and remove introduced Pi runtimes", () => {
  const fixture = createFixture();
  try {
    const entry = gitEntry("fixture-git", "fixture-git-package");
    const registry = fixtureRegistry([entry]);
    const installPath = path.join(fixture.ctx.agentDir, entry.checkoutPath);
    const commandStdio = ["ignore", "ignore", "inherit"];
    const calls = [];

    assert.throws(
      () => applyManagedExtensionBaselines(fixture.ctx, {
        registry,
        commandStdio,
        commandRunner(command, args, options = {}) {
          calls.push({ command, args: [...args], cwd: options.cwd || "", stdio: options.stdio });
          if (command === "git" && args[0] === "clone") {
            fs.mkdirSync(path.join(installPath, ".git"), { recursive: true });
            fs.writeFileSync(path.join(installPath, "package.json"), '{"name":"fixture-git-package"}\n');
          }
          if (command === "npm") {
            const nested = path.join(
              installPath,
              "node_modules",
              "fixture-dependency",
              "node_modules",
              "@mariozechner",
              "pi-coding-agent",
            );
            fs.mkdirSync(nested, { recursive: true });
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
      /managed Git extension install introduced and removed a parallel Pi runtime/,
    );

    const npmCall = calls.find((call) => call.command === "npm");
    assert.deepEqual(npmCall?.args, [
      "install",
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    assert.equal(npmCall?.cwd, installPath);
    assert.deepEqual(npmCall?.stdio, commandStdio);
    assert.deepEqual(findPhysicalPiCodingAgentPackages(installPath), []);
    assert.equal(fs.existsSync(path.join(fixture.ctx.stateDir, "extension-ledger.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("bundled content revisions upgrade only pristine older managed content", () => {
  const fixture = createFixture();
  try {
    const entry = bundledEntry(fixture, {
      id: "fixture-bundled",
      version: "1.0.0",
      contentRevision: 2,
      content: "managed revision 2\n",
    });
    const registry = fixtureRegistry([entry]);
    const installPath = path.join(fixture.ctx.agentDir, entry.bundlePath);
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, "index.js"), "managed revision 1\n");
    const previousManagedHash = hashDirectory(installPath);

    const inspect = (prior) => inspectManagedExtensions(fixture.ctx, {
      registry,
      sourceRoot: fixture.sourceRoot,
      ledger: {
        schema: "pi67.extension-ledger.v1",
        extensions: { [entry.id]: prior },
      },
    }).extensions[0];

    const upgrade = inspect({
      lastManagedVersion: "1.0.0",
      lastManagedRevision: 1,
      lastManagedHash: previousManagedHash,
    });
    assert.equal(upgrade.managedPristine, true);
    assert.equal(upgrade.installedContentRevision, 1);
    assert.equal(upgrade.status, "below-baseline");
    assert.equal(upgrade.action, "upgrade");

    const equalRevisionDrift = inspect({
      lastManagedVersion: "1.0.0",
      lastManagedRevision: 2,
      lastManagedHash: previousManagedHash,
    });
    assert.equal(equalRevisionDrift.status, "user-managed-diverged");
    assert.equal(equalRevisionDrift.action, "keep-conflict");

    const regressedBaseline = inspect({
      lastManagedVersion: "1.0.0",
      lastManagedRevision: 3,
      lastManagedHash: previousManagedHash,
    });
    assert.equal(regressedBaseline.status, "user-managed-ahead");
    assert.equal(regressedBaseline.action, "keep");

    const ambiguousLegacy = inspect({
      lastManagedVersion: "1.0.0",
      lastManagedHash: previousManagedHash,
    });
    assert.equal(ambiguousLegacy.status, "user-managed-diverged");
    assert.equal(ambiguousLegacy.action, "keep-conflict");

    fs.writeFileSync(path.join(installPath, "index.js"), "user customized content\n");
    const userDiverged = inspect({
      lastManagedVersion: "1.0.0",
      lastManagedRevision: 1,
      lastManagedHash: previousManagedHash,
    });
    assert.equal(userDiverged.managedPristine, false);
    assert.equal(userDiverged.status, "user-managed-diverged");
    assert.equal(userDiverged.action, "keep-conflict");

    fs.cpSync(path.join(fixture.sourceRoot, entry.bundlePath), installPath, {
      recursive: true,
      force: true,
    });
    const atBaseline = inspect({});
    assert.equal(atBaseline.installedContentRevision, 2);
    assert.equal(atBaseline.status, "at-baseline");
    assert.equal(atBaseline.action, "keep");
  } finally {
    fixture.cleanup();
  }
});

test("bundled apply records revisions and legacy at-baseline ledgers migrate without content writes", () => {
  const fixture = createFixture();
  try {
    const entry = bundledEntry(fixture, {
      id: "fixture-bundled",
      version: "1.0.0",
      contentRevision: 2,
      content: "managed revision 2\n",
    });
    const registry = fixtureRegistry([entry]);
    const installPath = path.join(fixture.ctx.agentDir, entry.bundlePath);
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, "index.js"), "managed revision 1\n");
    const previousManagedHash = hashDirectory(installPath);
    const ledgerPath = path.join(fixture.ctx.stateDir, "extension-ledger.json");
    fs.mkdirSync(fixture.ctx.stateDir, { recursive: true });
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      schema: "pi67.extension-ledger.v1",
      updatedAt: "fixed",
      extensions: {
        [entry.id]: {
          lastManagedVersion: "1.0.0",
          lastManagedRevision: 1,
          lastManagedHash: previousManagedHash,
        },
      },
    })}\n`);

    const applied = applyManagedExtensionBaselines(fixture.ctx, {
      registry,
      sourceRoot: fixture.sourceRoot,
    });
    assert.deepEqual(applied.applied, [{ id: entry.id, action: "upgrade" }]);
    assert.equal(fs.readFileSync(path.join(installPath, "index.js"), "utf8"), "managed revision 2\n");
    assert.equal(applied.after.extensions[0].status, "at-baseline");
    assert.equal(applied.ledger.extensions[entry.id].releaseBaselineRevision, 2);
    assert.equal(applied.ledger.extensions[entry.id].lastManagedRevision, 2);
    assert.equal(applied.ledger.extensions[entry.id].lastManagedHash, entry.contentHash);

    const migratedFixture = createFixture();
    try {
      const migratedEntry = bundledEntry(migratedFixture, {
        id: "fixture-migrated",
        version: "1.0.0",
        contentRevision: 1,
        content: "current managed content\n",
      });
      const migratedRegistry = fixtureRegistry([migratedEntry]);
      const migratedInstall = path.join(migratedFixture.ctx.agentDir, migratedEntry.bundlePath);
      fs.mkdirSync(path.dirname(migratedInstall), { recursive: true });
      fs.cpSync(path.join(migratedFixture.sourceRoot, migratedEntry.bundlePath), migratedInstall, { recursive: true });
      const migratedLedgerPath = path.join(migratedFixture.ctx.stateDir, "extension-ledger.json");
      fs.mkdirSync(migratedFixture.ctx.stateDir, { recursive: true });
      fs.writeFileSync(migratedLedgerPath, `${JSON.stringify({
        schema: "pi67.extension-ledger.v1",
        updatedAt: "fixed",
        extensions: {
          [migratedEntry.id]: {
            lastManagedVersion: "1.0.0",
            lastManagedHash: migratedEntry.contentHash,
          },
        },
      })}\n`);
      const contentBefore = fs.readFileSync(path.join(migratedInstall, "index.js"), "utf8");

      const migrated = applyManagedExtensionBaselines(migratedFixture.ctx, {
        registry: migratedRegistry,
        sourceRoot: migratedFixture.sourceRoot,
      });
      assert.deepEqual(migrated.applied, []);
      assert.equal(fs.readFileSync(path.join(migratedInstall, "index.js"), "utf8"), contentBefore);
      assert.equal(migrated.ledger.extensions[migratedEntry.id].releaseBaselineRevision, 1);
      assert.equal(migrated.ledger.extensions[migratedEntry.id].lastManagedRevision, 1);
      const ledgerAfterMigration = fs.readFileSync(migratedLedgerPath, "utf8");

      const noOp = applyManagedExtensionBaselines(migratedFixture.ctx, {
        registry: migratedRegistry,
        sourceRoot: migratedFixture.sourceRoot,
      });
      assert.deepEqual(noOp.applied, []);
      assert.equal(fs.readFileSync(migratedLedgerPath, "utf8"), ledgerAfterMigration);
    } finally {
      migratedFixture.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test("bundled revision dry-run preserves content and ledger", () => {
  const fixture = createFixture();
  try {
    const entry = bundledEntry(fixture, {
      id: "fixture-bundled",
      version: "1.0.0",
      contentRevision: 2,
      content: "managed revision 2\n",
    });
    const registry = fixtureRegistry([entry]);
    const installPath = path.join(fixture.ctx.agentDir, entry.bundlePath);
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, "index.js"), "managed revision 1\n");
    const ledgerPath = path.join(fixture.ctx.stateDir, "extension-ledger.json");
    fs.mkdirSync(fixture.ctx.stateDir, { recursive: true });
    const originalLedger = `${JSON.stringify({
      schema: "pi67.extension-ledger.v1",
      updatedAt: "fixed",
      extensions: {
        [entry.id]: {
          lastManagedVersion: "1.0.0",
          lastManagedRevision: 1,
          lastManagedHash: hashDirectory(installPath),
        },
      },
    })}\n`;
    fs.writeFileSync(ledgerPath, originalLedger);

    const dryRun = applyManagedExtensionBaselines(fixture.ctx, {
      dryRun: true,
      registry,
      sourceRoot: fixture.sourceRoot,
    });
    assert.deepEqual(dryRun.applied, [{ id: entry.id, action: "upgrade-dry-run" }]);
    assert.equal(fs.readFileSync(path.join(installPath, "index.js"), "utf8"), "managed revision 1\n");
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), originalLedger);
  } finally {
    fixture.cleanup();
  }
});

test("physical Pi runtime inspection finds top-level and nested new and legacy namespaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-managed-peer-scan-"));
  try {
    const npmDir = path.join(root, "npm");
    const topLevel = path.join(npmDir, "node_modules", "@earendil-works", "pi-coding-agent");
    const nested = path.join(
      npmDir,
      "node_modules",
      "fixture-extension",
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
    );
    fs.mkdirSync(topLevel, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    assert.deepEqual(findPhysicalPiCodingAgentPackages(npmDir), [nested, topLevel].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-managed-install-"));
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(root, "state");
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  return {
    root,
    sourceRoot,
    ctx: { agentDir, stateDir, repoRoot: sourceRoot },
    templates: new Map(),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function fixtureEntry(fixture, { id, packageName, version, runtimeDependencies = {} }) {
  const template = path.join(fixture.root, "templates", id);
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, "package.json"), `${JSON.stringify({ name: packageName, version })}\n`);
  fs.writeFileSync(path.join(template, "index.js"), `export const fixture = ${JSON.stringify(id)};\n`);
  fixture.templates.set(packageName, template);
  return {
    ...npmEntry(id, packageName, version, runtimeDependencies),
    contentHash: hashDirectory(template),
  };
}

function npmEntry(id, packageName, version, runtimeDependencies = {}) {
  return {
    id,
    sourceKind: "npm",
    settingsSpec: `npm:${packageName}`,
    packageName,
    minimumVersion: version,
    runtimeDependencies,
    role: "fixture",
  };
}

function gitEntry(id, packageName) {
  return {
    id,
    sourceKind: "git",
    settingsSpec: `git:github.com/example/${id}`,
    packageName,
    repoUrl: `https://github.com/example/${id}.git`,
    checkoutPath: `git/github.com/example/${id}`,
    minimumCommit: "0123456789abcdef0123456789abcdef01234567",
    role: "fixture",
  };
}

function bundledEntry(fixture, { id, version, contentRevision, content }) {
  const bundlePath = path.join("extensions", id);
  const sourcePath = path.join(fixture.sourceRoot, bundlePath);
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, "index.js"), content);
  return {
    id,
    sourceKind: "bundled",
    bundlePath,
    minimumVersion: version,
    contentRevision,
    contentHash: hashDirectory(sourcePath),
    role: "fixture",
  };
}

function fixtureRegistry(entries) {
  return {
    schema: "pi67.managed-extension-baselines.v2",
    policy: {},
    extensions: entries,
  };
}

function writePatchers(sourceRoot) {
  const scripts = path.join(sourceRoot, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "pi67-patch-pi-until-done-runtime-queue.mjs"), "export {};\n");
  fs.writeFileSync(path.join(scripts, "pi67-patch-pi-smart-fetch-charset.mjs"), "export {};\n");
}

function installFixtureClosure(fixture, entries) {
  const npmDir = path.join(fixture.ctx.agentDir, "npm");
  const nodeModules = path.join(npmDir, "node_modules");
  const packages = { "": { name: "pi67-managed-test", private: true } };
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const entry of entries) {
    const target = path.join(nodeModules, ...entry.packageName.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(fixture.templates.get(entry.packageName), target, { recursive: true });
    packages[`node_modules/${entry.packageName}`] = { version: entry.minimumVersion };
  }
  for (const [packageName, version] of mergedRuntimeDependencies(entries)) {
    const target = path.join(nodeModules, ...packageName.split("/"));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify({ name: packageName, version })}\n`);
    packages[`node_modules/${packageName}`] = { version };
  }
  fs.writeFileSync(path.join(npmDir, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages })}\n`);
}

function mergedRuntimeDependencies(entries) {
  const dependencies = new Map();
  for (const entry of entries) {
    for (const pair of Object.entries(entry.runtimeDependencies || {})) dependencies.set(...pair);
  }
  return dependencies;
}
