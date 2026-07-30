import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runFileTransaction,
  workspaceResource,
} from "../../packages/pi67-cli/src/lib/file-transaction.mjs";
import {
  activateDistroRelease,
  migrateRuntimeLayout,
  readCurrentRelease,
  recoverPendingRuntimeMigration,
  rollbackRuntimeMigration,
} from "../../packages/pi67-cli/src/lib/release-store.mjs";
import {
  beginUpdateLifecycle,
  createRuntimeBackup,
  restoreRuntimeBackup,
} from "../../packages/pi67-cli/src/lib/update-safety.mjs";
import { resolveStateDir } from "../../packages/pi67-cli/src/lib/paths.mjs";
import { beginWorkspaceOperation } from "../../packages/pi67-cli/src/lib/workspace-operation-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fileTransactionModule = pathToFileURL(path.join(
  repoRoot,
  "packages/pi67-cli/src/lib/file-transaction.mjs",
)).href;
const releaseStoreModule = pathToFileURL(path.join(
  repoRoot,
  "packages/pi67-cli/src/lib/release-store.mjs",
)).href;

test("workspace state roots use canonical filesystem identity for path aliases", (t) => {
  const root = tempRoot(t, "pi67-workspace-state-");
  const homeDir = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const alias = path.join(root, "workspace-alias");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");

  assert.equal(resolveStateDir(workspace, homeDir), resolveStateDir(alias, homeDir));
  assert.equal(
    resolveStateDir(path.join(workspace, "future"), homeDir),
    resolveStateDir(path.join(alias, "future"), homeDir),
  );
});

test("canonical workspace locks serialize path aliases and preserve replacement owners", (t) => {
  const root = tempRoot(t, "pi67-workspace-lock-");
  const agentDir = path.join(root, "agent");
  const alias = path.join(root, "agent-alias");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.symlinkSync(agentDir, alias, process.platform === "win32" ? "junction" : "dir");
  const primary = { agentDir, stateDir: path.join(stateRoot, "workspaces", "primary") };
  const secondary = { agentDir: alias, stateDir: path.join(stateRoot, "workspaces", "alias") };

  const first = beginWorkspaceOperation(primary, { operation: "fixture-primary" });
  assert.equal(fs.existsSync(first.legacyLockPath), true);
  assert.equal(JSON.parse(fs.readFileSync(first.legacyLockPath, "utf8")).schema, "pi67.update-lock.v1");
  assert.throws(
    () => beginWorkspaceOperation(secondary, { operation: "fixture-alias" }),
    /another pi-67 workspace operation appears to be running/,
  );
  assert.throws(
    () => beginUpdateLifecycle(secondary, { operation: "fixture-update", backupRuntime: false }),
    /another pi-67 workspace operation appears to be running/,
  );

  const ownerFile = path.join(first.lockPath, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, `${JSON.stringify({ ...owner, ownerId: "replacement-owner" })}\n`);
  assert.throws(() => first.release(), /ownership changed/);
  assert.equal(fs.existsSync(first.lockPath), true);
  fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`);
  first.release();

  const lockPath = beginWorkspaceOperation(secondary, { operation: "dry-run", dryRun: true }).lockPath;
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
    schema: "pi67.workspace-operation-lock.v1",
    ownerId: "dead-owner",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    operation: "dead-fixture",
    createdAt: new Date().toISOString(),
  })}\n`);
  const recovered = beginWorkspaceOperation(primary, { operation: "recover-stale" });
  assert.equal(recovered.lockPath, lockPath);
  recovered.release();
});

test("workspace operations interoperate with live and stale legacy update locks", (t) => {
  const root = tempRoot(t, "pi67-legacy-update-lock-");
  const ctx = fixtureContext(root);
  const dryRun = beginWorkspaceOperation(ctx, { operation: "fixture", dryRun: true });
  fs.mkdirSync(path.dirname(dryRun.legacyLockPath), { recursive: true });
  write(dryRun.legacyLockPath, `${JSON.stringify({
    schema: "pi67.update-lock.v1",
    pid: process.pid,
    operation: "legacy-live",
    createdAt: new Date().toISOString(),
  })}\n`);
  assert.throws(
    () => beginWorkspaceOperation(ctx, { operation: "new-manager" }),
    /legacy update lock/,
  );
  assert.equal(fs.existsSync(dryRun.lockPath), false);

  write(dryRun.legacyLockPath, `${JSON.stringify({
    schema: "pi67.update-lock.v1",
    pid: 2_147_483_647,
    operation: "legacy-dead",
    createdAt: new Date().toISOString(),
  })}\n`);
  const recovered = beginWorkspaceOperation(ctx, { operation: "new-manager" });
  assert.equal(JSON.parse(fs.readFileSync(recovered.legacyLockPath, "utf8")).ownerId, recovered.ownerId);
  recovered.release();
  assert.equal(fs.existsSync(recovered.legacyLockPath), false);
});

test("file transaction compensates a synchronous mid-apply failure", (t) => {
  const root = tempRoot(t, "pi67-file-transaction-");
  const ctx = fixtureContext(root);
  const targetA = path.join(ctx.agentDir, "a.txt");
  const targetB = path.join(ctx.agentDir, "b.txt");
  const sourceA = path.join(root, "source-a.txt");
  const sourceB = path.join(root, "source-b.txt");
  write(targetA, "old-a\n");
  write(targetB, "old-b\n");
  write(sourceA, "new-a\n");
  write(sourceB, "new-b\n");

  assert.throws(() => runFileTransaction(ctx, {
    operation: "fault-fixture",
    faultAfter: 1,
    mutations: [
      { source: sourceA, target: targetA },
      { source: sourceB, target: targetB },
    ],
  }), /injected file transaction failure/);
  assert.equal(fs.readFileSync(targetA, "utf8"), "old-a\n");
  assert.equal(fs.readFileSync(targetB, "utf8"), "old-b\n");
  assert.equal(countFiles(path.join(ctx.stateDir, "transactions")), 0);
});

test("file transaction rejects targets outside or equal to workspace roots before staging", (t) => {
  const root = tempRoot(t, "pi67-file-transaction-boundary-");
  const ctx = fixtureContext(root);
  const source = path.join(root, "source.txt");
  const outside = path.join(root, "outside.txt");
  write(source, "replacement\n");
  write(outside, "must-survive\n");

  for (const target of [outside, ctx.agentDir, ctx.stateDir]) {
    assert.throws(() => runFileTransaction(ctx, {
      operation: "boundary-fixture",
      mutations: [{ source, target }],
    }), /file transaction target escapes its workspace/);
  }

  assert.equal(fs.readFileSync(outside, "utf8"), "must-survive\n");
  assert.equal(fs.statSync(ctx.agentDir).isDirectory(), true);
  assert.equal(fs.statSync(ctx.stateDir).isDirectory(), true);

  const alias = path.join(root, "agent-alias");
  const inside = path.join(ctx.agentDir, "same.txt");
  fs.symlinkSync(ctx.agentDir, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => runFileTransaction(ctx, {
    operation: "duplicate-alias-fixture",
    mutations: [
      { source, target: inside },
      { source, target: path.join(alias, "same.txt") },
    ],
  }), /duplicate file transaction target/);
  assert.equal(fs.existsSync(inside), false);
  assert.equal(countFiles(path.join(workspaceResource(ctx).stateRoot, "transactions")), 0);
});

test("transaction recovery fails closed on corrupt or cross-workspace journals", (t) => {
  const root = tempRoot(t, "pi67-file-journal-guard-");
  const ctx = fixtureContext(root);
  const resource = workspaceResource(ctx);
  const transactionsRoot = path.join(resource.stateRoot, "transactions", resource.resourceId);
  const corruptDir = path.join(transactionsRoot, "corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  write(path.join(corruptDir, "journal.json"), "{not-json\n");

  assert.throws(
    () => beginWorkspaceOperation(ctx, { operation: "corrupt-journal-recovery" }),
    /could not read pending file transaction journal/,
  );
  assert.equal(fs.existsSync(corruptDir), true);
  fs.rmSync(corruptDir, { recursive: true, force: true });

  const outside = path.join(root, "outside.txt");
  write(outside, "must-survive\n");
  const tamperedDir = path.join(transactionsRoot, "tampered");
  fs.mkdirSync(path.join(tamperedDir, "staged"), { recursive: true });
  fs.mkdirSync(path.join(tamperedDir, "rollback"), { recursive: true });
  write(path.join(tamperedDir, "journal.json"), `${JSON.stringify({
    schema: "pi67.file-transaction.v1",
    id: "tampered",
    operation: "tampered-fixture",
    agentDir: resource.agentDir,
    stateDir: ctx.stateDir,
    status: "applying",
    mutations: [{
      target: outside,
      staged: null,
      rollback: { kind: "missing", path: "" },
    }],
  })}\n`);

  assert.throws(
    () => beginWorkspaceOperation(ctx, { operation: "tampered-journal-recovery" }),
    /target escapes its workspace/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "must-survive\n");
  assert.equal(fs.existsSync(tamperedDir), true);
  fs.rmSync(tamperedDir, { recursive: true, force: true });

  const artifactTamperedDir = path.join(transactionsRoot, "artifact-tampered");
  fs.mkdirSync(path.join(artifactTamperedDir, "staged"), { recursive: true });
  fs.mkdirSync(path.join(artifactTamperedDir, "rollback"), { recursive: true });
  write(path.join(artifactTamperedDir, "journal.json"), `${JSON.stringify({
    schema: "pi67.file-transaction.v1",
    id: "artifact-tampered",
    operation: "artifact-tampered-fixture",
    agentDir: resource.agentDir,
    stateDir: ctx.stateDir,
    status: "applying",
    mutations: [{
      target: path.join(ctx.agentDir, "inside.txt"),
      staged: null,
      rollback: { kind: "file", path: outside },
    }],
  })}\n`);
  assert.throws(
    () => beginWorkspaceOperation(ctx, { operation: "artifact-journal-recovery" }),
    /rollback path escapes its transaction directory/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "must-survive\n");
});

test("workspace lock recovers a process-crashed file transaction before the next write", async (t) => {
  const root = tempRoot(t, "pi67-file-crash-");
  const ctx = fixtureContext(root);
  const targetA = path.join(ctx.agentDir, "a.txt");
  const targetB = path.join(ctx.agentDir, "b.txt");
  const sourceA = path.join(root, "source-a.txt");
  const sourceB = path.join(root, "source-b.txt");
  const ready = path.join(root, "ready");
  write(targetA, "old-a\n");
  write(targetB, "old-b\n");
  write(sourceA, "new-a\n");
  write(sourceB, "new-b\n");

  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { runFileTransaction } from ${JSON.stringify(fileTransactionModule)};
    const ctx = JSON.parse(process.env.PI67_FIXTURE_CTX);
    runFileTransaction(ctx, {
      operation: "crash-fixture",
      mutations: JSON.parse(process.env.PI67_FIXTURE_MUTATIONS),
      afterMutation(count) {
        if (count !== 1) return;
        fs.writeFileSync(process.env.PI67_FIXTURE_READY, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
    });
  `], {
    env: {
      ...process.env,
      PI67_FIXTURE_CTX: JSON.stringify(ctx),
      PI67_FIXTURE_MUTATIONS: JSON.stringify([
        { source: sourceA, target: targetA },
        { source: sourceB, target: targetB },
      ]),
      PI67_FIXTURE_READY: ready,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFile(ready, child);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(fs.readFileSync(targetA, "utf8"), "new-a\n");

  const alias = path.join(root, "agent-alias");
  fs.symlinkSync(ctx.agentDir, alias, process.platform === "win32" ? "junction" : "dir");
  const recoveryCtx = {
    ...ctx,
    agentDir: alias,
    stateDir: path.join(ctx.stateDir, "workspaces", "alias"),
  };
  const operation = beginWorkspaceOperation(recoveryCtx, { operation: "post-crash-write" });
  assert.equal(operation.recoveredTransactions.length, 1);
  operation.release();
  assert.equal(fs.readFileSync(targetA, "utf8"), "old-a\n");
  assert.equal(fs.readFileSync(targetB, "utf8"), "old-b\n");
});

test("runtime restore rejects tampering and cross-workspace use before changing live files", (t) => {
  const root = tempRoot(t, "pi67-backup-integrity-");
  const ctx = fixtureContext(root);
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"old"}\n');
  const backupDir = path.join(ctx.stateDir, "backups", "verified");
  createRuntimeBackup(ctx, backupDir, { operation: "fixture" });
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"live"}\n');
  write(path.join(backupDir, "files", "settings.json"), '{"theme":"tampered"}\n');

  assert.throws(() => restoreRuntimeBackup(ctx, backupDir), /backup integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "settings.json"), "utf8"), '{"theme":"live"}\n');

  write(path.join(backupDir, "files", "settings.json"), '{"theme":"old"}\n');
  const manifestFile = path.join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files = manifest.files.filter((item) => item.path !== "auth.json");
  write(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => restoreRuntimeBackup(ctx, backupDir), /every preserved runtime file exactly once/);
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "settings.json"), "utf8"), '{"theme":"live"}\n');

  const other = fixtureContext(path.join(root, "other"));
  assert.throws(() => restoreRuntimeBackup(other, backupDir), /different workspace/);
});

test("runtime restore compensates a mid-transaction failure and preserves its pre-restore backup", (t) => {
  const root = tempRoot(t, "pi67-backup-transaction-");
  const ctx = fixtureContext(root);
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"old"}\n');
  write(path.join(ctx.agentDir, "auth.json"), '{"fixture":"old"}\n');
  const backupDir = path.join(ctx.stateDir, "backups", "verified");
  createRuntimeBackup(ctx, backupDir, { operation: "fixture" });
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"live"}\n');
  write(path.join(ctx.agentDir, "auth.json"), '{"fixture":"live"}\n');

  assert.throws(
    () => restoreRuntimeBackup(ctx, backupDir, { faultAfter: 1 }),
    /injected file transaction failure/,
  );
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "settings.json"), "utf8"), '{"theme":"live"}\n');
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "auth.json"), "utf8"), '{"fixture":"live"}\n');
  assert.equal(
    readDirectoryNames(path.join(ctx.stateDir, "backups")).some((name) => name.includes("pre-restore")),
    true,
  );
});

test("release activation compensates synchronous failure and recovers an abrupt process crash", async (t) => {
  const root = tempRoot(t, "pi67-release-transaction-");
  const ctx = fixtureContext(root);
  const sourceV1 = createReleaseFixture(path.join(root, "source-v1"), "0.15.7", "release-one\n");
  const sourceV2 = createReleaseFixture(path.join(root, "source-v2"), "0.15.8", "release-two\n");
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"private"}\n');
  activateDistroRelease(ctx, { sourceRoot: sourceV1 });
  const before = activeReleaseSnapshot(ctx);

  assert.throws(
    () => activateDistroRelease(ctx, { sourceRoot: sourceV2, faultAfter: 2 }),
    /injected file transaction failure/,
  );
  assert.deepEqual(activeReleaseSnapshot(ctx), before);
  assert.equal(readCurrentRelease(ctx).version, "0.15.7");

  const ready = path.join(root, "release-ready");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { activateDistroRelease } from ${JSON.stringify(releaseStoreModule)};
    const ctx = JSON.parse(process.env.PI67_FIXTURE_CTX);
    activateDistroRelease(ctx, {
      sourceRoot: process.env.PI67_FIXTURE_SOURCE,
      afterMutation(count) {
        if (count !== 2) return;
        fs.writeFileSync(process.env.PI67_FIXTURE_READY, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
    });
  `], {
    env: {
      ...process.env,
      PI67_FIXTURE_CTX: JSON.stringify(ctx),
      PI67_FIXTURE_SOURCE: sourceV2,
      PI67_FIXTURE_READY: ready,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFile(ready, child);
  child.kill("SIGKILL");
  await once(child, "exit");

  const recovery = beginWorkspaceOperation(ctx, { operation: "release-crash-recovery" });
  assert.equal(recovery.recoveredTransactions.length, 1);
  recovery.release();
  assert.deepEqual(activeReleaseSnapshot(ctx), before);
  assert.equal(readCurrentRelease(ctx).version, "0.15.7");
});

test("runtime migration journals before rename and restores a crash-interrupted legacy layout", async (t) => {
  const root = tempRoot(t, "pi67-migration-crash-");
  const ctx = fixtureContext(root);
  const source = createReleaseFixture(path.join(root, "source"), "0.15.7", "release\n");
  ctx.repoRoot = source;
  fs.mkdirSync(path.join(ctx.agentDir, ".git"), { recursive: true });
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"legacy"}\n');
  const ready = path.join(root, "migration-ready");

  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { migrateRuntimeLayout } from ${JSON.stringify(releaseStoreModule)};
    const ctx = JSON.parse(process.env.PI67_FIXTURE_CTX);
    migrateRuntimeLayout(ctx, {
      sourceRoot: process.env.PI67_FIXTURE_SOURCE,
      afterLegacyRename() {
        fs.writeFileSync(process.env.PI67_FIXTURE_READY, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
    });
  `], {
    env: {
      ...process.env,
      PI67_FIXTURE_CTX: JSON.stringify(ctx),
      PI67_FIXTURE_SOURCE: source,
      PI67_FIXTURE_READY: ready,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFile(ready, child);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(fs.existsSync(ctx.agentDir), false);

  const operation = beginWorkspaceOperation(ctx, { operation: "post-migration-crash-write" });
  assert.equal(operation.recoveredMigration.recovery, "migration-compensated");
  operation.release();
  assert.equal(fs.existsSync(path.join(ctx.agentDir, ".git")), true);
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "settings.json"), "utf8"), '{"theme":"legacy"}\n');
  const journalFile = path.join(ctx.stateDir, "migrations", readDirectoryNames(path.join(ctx.stateDir, "migrations"))[0]);
  assert.equal(JSON.parse(fs.readFileSync(journalFile, "utf8")).status, "compensated");
});

test("runtime migration recovery rejects corrupt and escaping backup journals before mutation", (t) => {
  const root = tempRoot(t, "pi67-migration-journal-guard-");
  const ctx = fixtureContext(root);
  const source = createReleaseFixture(path.join(root, "source"), "0.15.7", "release\n");
  ctx.repoRoot = source;
  fs.mkdirSync(path.join(ctx.agentDir, ".git"), { recursive: true });
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"legacy"}\n');
  migrateRuntimeLayout(ctx, { sourceRoot: source });
  const journalFile = path.join(ctx.stateDir, "migrations", readDirectoryNames(path.join(ctx.stateDir, "migrations"))[0]);
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const outside = path.join(root, "outside-legacy-agent");
  fs.mkdirSync(outside, { recursive: true });
  write(path.join(outside, "sentinel.txt"), "preserve\n");
  write(journalFile, `${JSON.stringify({
    ...journal,
    status: "legacy-renamed",
    backupAgentDir: outside,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  })}\n`);

  assert.throws(
    () => beginWorkspaceOperation(ctx, { operation: "tampered-migration-recovery" }),
    /invalid runtime migration journal \(legacy backup path\)/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "preserve\n");

  write(journalFile, "{not-json\n");
  assert.throws(
    () => recoverPendingRuntimeMigration(ctx),
    /could not read runtime migration journal/,
  );
});

test("runtime migration and migration rollback keep their directory and pointer journals consistent", (t) => {
  const root = tempRoot(t, "pi67-migration-roundtrip-");
  const ctx = fixtureContext(root);
  const source = createReleaseFixture(path.join(root, "source"), "0.15.7", "release\n");
  ctx.repoRoot = source;
  fs.mkdirSync(path.join(ctx.agentDir, ".git"), { recursive: true });
  write(path.join(ctx.agentDir, "settings.json"), '{"theme":"legacy"}\n');

  const migration = migrateRuntimeLayout(ctx, { sourceRoot: source });
  assert.equal(migration.status, "completed");
  assert.equal(readCurrentRelease(ctx).version, "0.15.7");
  assert.equal(fs.existsSync(migration.backupAgentDir), true);

  const rollback = rollbackRuntimeMigration(ctx);
  assert.equal(rollback.journal.status, "rolled-back");
  assert.equal(fs.existsSync(path.join(ctx.agentDir, ".git")), true);
  assert.equal(fs.readFileSync(path.join(ctx.agentDir, "settings.json"), "utf8"), '{"theme":"legacy"}\n');
  assert.equal(readCurrentRelease(ctx), null);
});

test("topology-mutating command surfaces use the canonical workspace operation lock", () => {
  const expected = new Map([
    ["install.mjs", ["beginWorkspaceOperation", "install-repair"]],
    ["migrate.mjs", ["beginWorkspaceOperation", "migrate"]],
    ["rollback.mjs", ["beginWorkspaceOperation", "release-rollback"]],
    ["backups.mjs", ["backup-restore", "backups-prune", "backups-archive"]],
    ["extensions.mjs", ["beginWorkspaceOperation", "extension-restore"]],
    ["themes.mjs", ["beginWorkspaceOperation", "themes-set"]],
  ]);
  for (const [file, markers] of expected) {
    const source = fs.readFileSync(path.join(repoRoot, "packages/pi67-cli/src/commands", file), "utf8");
    for (const marker of markers) assert.match(source, new RegExp(marker));
  }
  const updateSafety = fs.readFileSync(
    path.join(repoRoot, "packages/pi67-cli/src/lib/update-safety.mjs"),
    "utf8",
  );
  assert.match(updateSafety, /beginWorkspaceOperation/);
});

function fixtureContext(root) {
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    agentDir,
    repoRoot: root,
    stateDir: path.join(root, "state"),
  };
}

function createReleaseFixture(root, version, readme) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "extensions", "fixture"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared-skills", "fixture"), { recursive: true });
  write(path.join(root, "VERSION"), `${version}\n`);
  write(path.join(root, "AGENTS.md"), `fixture ${version}\n`);
  write(path.join(root, "README.md"), readme);
  write(path.join(root, "scripts", "fixture.sh"), `#!/bin/sh\necho ${version}\n`);
  write(path.join(root, "extensions", "fixture", "index.ts"), "export {};\n");
  write(path.join(root, "shared-skills", "fixture", "SKILL.md"), `skill ${version}\n`);
  write(path.join(root, "shared-skill-packs.json"), '{"schema":"pi67.shared-skill-packs.v1","packs":[]}\n');
  return root;
}

function activeReleaseSnapshot(ctx) {
  const files = [
    "AGENTS.md",
    "README.md",
    "VERSION",
    path.join("scripts", "fixture.sh"),
    path.join("shared-skills", "fixture", "SKILL.md"),
    "shared-skill-packs.json",
    "settings.json",
  ];
  return Object.fromEntries(files.map((relative) => [
    relative.replaceAll(path.sep, "/"),
    fs.readFileSync(path.join(ctx.agentDir, relative), "utf8"),
  ]).concat([["current.json", fs.readFileSync(path.join(ctx.stateDir, "current.json"), "utf8")]]));
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function readDirectoryNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (entry.isDirectory()) return count + countFiles(path.join(dir, entry.name));
      return count + 1;
    }, 0);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForFile(file, child, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderr = await streamText(child.stderr);
      throw new Error(`fixture child exited before readiness: ${stderr}`);
    }
    if (Date.now() - startedAt > timeoutMs) {
      child.kill("SIGKILL");
      throw new Error(`timed out waiting for fixture child: ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function streamText(stream) {
  let text = "";
  for await (const chunk of stream || []) text += String(chunk);
  return text;
}
