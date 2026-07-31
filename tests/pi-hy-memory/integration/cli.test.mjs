import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { upstreamPiInvocation } from "../../upstream-pi-runtime.mjs";
import {
  defaultMemoryConfig,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  memoryPaths,
  memoryStatus,
  restartMemoryService,
  startMemoryService,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "packages", "pi67-cli", "bin", "pi-67.mjs");
const serviceScript = path.join(root, "extensions", "pi-hy-memory", "service.py");
const extensionScript = path.join(root, "extensions", "pi-hy-memory", "index.ts");

test("memory CLI exposes help and an uninitialized read-only status", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-cli-"));
  try {
    const help = spawnSync(process.execPath, [cli, "memory", "--help"], { cwd: root, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /doctor \[--deep\]/);
    assert.match(help.stdout, /runtime prune --dry-run/);
    const status = spawnSync(process.execPath, [cli, "memory", "status", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: home },
    });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.initialized, false);
    assert.deepEqual(payload.nextSteps, ["pi-67 memory init"]);

    const inventory = spawnSync(process.execPath, [cli, "memory", "runtime", "inventory", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: home },
    });
    assert.equal(inventory.status, 0, inventory.stderr);
    const runtimeInventory = JSON.parse(inventory.stdout);
    assert.equal(runtimeInventory.generationCount, 0);
    assert.equal(runtimeInventory.selectionValid, false);

    const unsafePrune = spawnSync(process.execPath, [cli, "memory", "runtime", "prune"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: home },
    });
    assert.equal(unsafePrune.status, 2);
    assert.match(unsafePrune.stderr, /preview-only and requires --dry-run/);

    const prunePlan = spawnSync(process.execPath, [cli, "memory", "runtime", "prune", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: home },
    });
    assert.equal(prunePlan.status, 0, prunePlan.stderr);
    const parsedPrunePlan = JSON.parse(prunePlan.stdout);
    assert.equal(parsedPrunePlan.executable, false);
    assert.match(parsedPrunePlan.planId, /^sha256:[0-9a-f]{64}$/);
    assert.ok(parsedPrunePlan.blockedReasons.includes("deletion-not-implemented"));
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("real upstream Pi loads Hy-Memory tools while uninitialized", { timeout: 20_000 }, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-runtime-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const agentDir = path.join(tempRoot, ".pi", "agent");
  const projectDir = path.join(tempRoot, "project");
  const markerPath = path.join(tempRoot, "captured-hy-memory-runtime.json");
  const probePath = path.join(tempRoot, "capture-hy-memory-runtime.ts");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`);
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  fs.writeFileSync(probePath, `import { writeFileSync } from "node:fs";
export default function captureHyMemoryRuntime(pi: any) {
  pi.on("before_agent_start", () => {
    const marker = process.env.PI67_HY_MEMORY_RUNTIME_MARKER;
    if (!marker) throw new Error("PI67_HY_MEMORY_RUNTIME_MARKER is required");
    writeFileSync(marker, JSON.stringify({
      tools: pi.getAllTools().map((item: any) => item.name).filter((name: string) => name.startsWith("hy_memory_")),
      activeTools: pi.getActiveTools(),
    }), "utf8");
    process.exit(0);
  });
}
`);
  const pi = upstreamPiInvocation(root, process.env.PI67_HY_MEMORY_PI_BIN);
  const toolNames = ["hy_memory_search", "hy_memory_add", "hy_memory_list", "hy_memory_forget"];
  const result = spawnSync(pi.command, [
    ...pi.args,
    "--offline",
    "--no-extensions",
    "--extension", extensionScript,
    "--extension", probePath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "--tools", toolNames.join(","),
    "--no-session",
    "--provider", "deepseek",
    "--model", "deepseek-chat",
    "--api-key", "fixture-not-a-secret",
    "--print", "runtime probe",
  ], {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "sessions"),
      PI67_HY_MEMORY_HOME: path.join(tempRoot, "memory"),
      PI67_HY_MEMORY_RUNTIME_MARKER: markerPath,
      PI_OFFLINE: "1",
    },
    shell: pi.shell,
    timeout: 15_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Pi runtime probe failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  const captured = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.deepEqual(captured.tools.sort(), [...toolNames].sort());
  assert.deepEqual(captured.activeTools.sort(), [...toolNames].sort());
});

test("memory init dry-run validates Pi auth but writes no memory state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-dry-run-"));
  try {
    const agentDir = path.join(tmp, "agent");
    const memoryHome = path.join(tmp, "memory");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"deepseek":{"type":"api_key","key":"test-only-not-a-real-credential"}}\n', { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, "--agent-dir", agentDir, "--repo-root", root, "memory", "init", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: memoryHome },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.initialized, false);
    assert.equal(fs.existsSync(memoryHome), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("memory upgrade stage failure returns one structured receipt without changing current selection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-upgrade-stage-failure-"));
  try {
    const memoryHome = path.join(tmp, "memory");
    const emptyRepo = path.join(tmp, "repo-without-service");
    const paths = memoryPaths(memoryHome);
    fs.mkdirSync(emptyRepo, { recursive: true });
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, "test-only-service-token-for-upgrade-stage");
    const before = fs.readFileSync(paths.runtimeFile);

    const result = await runCli(
      ["--repo-root", emptyRepo, "memory", "upgrade", "--json"],
      { ...process.env, PI67_HY_MEMORY_HOME: memoryHome },
    );
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schema, "pi67.memory-upgrade/v1");
    assert.equal(receipt.success, false);
    assert.equal(receipt.upgraded, false);
    assert.equal(receipt.phase, "STAGE");
    assert.match(receipt.error, /service source is missing/);
    assert.deepEqual(fs.readFileSync(paths.runtimeFile), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("destructive memory commands fail closed without --yes", () => {
  for (const args of [["forget", "memory-id"], ["digest"], ["reset"]]) {
    const result = spawnSync(process.execPath, [cli, "memory", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /requires --yes/);
  }
});

test("memory status and start fail closed on a tampered managed runtime", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-activation-tampered-"));
  try {
    const paths = memoryPaths(home);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const fixture = writeInitializedFixture(paths, "test-only-service-token-for-tamper");
    fs.writeFileSync(fixture.serviceScript, "tampered-content");

    const status = await memoryStatus({ agentDir: root }, { home });
    assert.equal(status.initialized, false);
    assert.equal(status.ready, false);
    assert.match(
      status.checks.find((item) => item.id === "runtime")?.message || "",
      /wrapper SHA-256 does not match/,
    );
    assert.ok(status.nextSteps.includes("pi-67 memory upgrade --force"));
    await assert.rejects(
      startMemoryService({ agentDir: root }, { home, timeoutMs: 100 }),
      /wrapper SHA-256 does not match/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory restart validates runtime integrity before stopping a live service", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-restart-tampered-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-restart";
  const instanceId = "restart-integrity-instance";
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    }));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const fixture = writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const ownership = {
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    };
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify(ownership)}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify(ownership)}\n`);
    fs.writeFileSync(fixture.serviceScript, "tampered-content");

    await assert.rejects(
      restartMemoryService({ agentDir: root }, { home, timeoutMs: 100 }),
      /wrapper SHA-256 does not match/,
    );
    assert.deepEqual(requests, [], "restart must reject before probing or shutting down the live service");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("service identity accepts OS aliases that resolve to the same private state directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-path-alias-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-path-alias";
  const instanceId = "path-alias-instance";
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    const realRoot = fs.realpathSync.native(paths.root);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: realRoot,
      dataDir: path.join(realRoot, "data"),
    }));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const realRoot = fs.realpathSync.native(paths.root);
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: realRoot,
      dataDir: path.join(realRoot, "data"),
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: realRoot,
      dataDir: path.join(realRoot, "data"),
      stage: "ready",
    })}\n`, { mode: 0o600 });

    const status = await memoryStatus({ agentDir: root }, { home });
    assert.equal(status.running, true);
    assert.equal(status.checks.find((item) => item.id === "service")?.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory status reports conflicting live service and lifetime owner PIDs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-duplicate-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-duplicate";
  const instanceId = "service-instance";
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"] , { stdio: "ignore" });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    }));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: owner.pid,
      instanceId: "owner-instance",
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);

    const status = await memoryStatus({ agentDir: root }, { home });
    assert.equal(status.running, false);
    const ownership = status.checks.find((item) => item.id === "service-ownership");
    assert.equal(ownership.ok, false);
    assert.equal(ownership.details.state, "duplicate");
    assert.deepEqual(new Set(ownership.details.pids), new Set([process.pid, owner.pid]));
    fs.unlinkSync(paths.lifetimeOwnerFile);
    const orphaned = await memoryStatus({ agentDir: root }, { home });
    assert.equal(orphaned.checks.find((item) => item.id === "service-ownership")?.details?.state, "orphan-service");
    await assert.rejects(
      startMemoryService({ agentDir: root }, { home, timeoutMs: 100 }),
      /ownership conflict: service PID .* is alive without lifetime ownership/,
    );
  } finally {
    owner.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory flush and digest exit non-zero when the service reports success=false", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-false-success-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-false-success";
  const instanceId = "false-success-instance";
  const server = http.createServer((request, response) => {
    const value = request.url === "/v1/info" ? {
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    } : { success: false, error: "fixture incomplete" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);

    for (const args of [["flush"], ["digest", "--yes"]]) {
      const result = await runCli(["memory", ...args], { ...process.env, PI67_HY_MEMORY_HOME: home });
      assert.equal(result.code, 1, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /reported success=false: fixture incomplete/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory forget reports active deletion without claiming historical purge", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-forget-semantics-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-forget";
  const instanceId = "forget-semantics-instance";
  const server = http.createServer((request, response) => {
    let value;
    if (request.url === "/v1/info") {
      value = {
        schema: "pi67-hy-memory-service/v1",
        pid: process.pid,
        instanceId,
        root: paths.root,
        dataDir: paths.dataDir,
      };
    } else if (request.url === "/v1/memories/failure-memory") {
      value = { success: false, deleted_count: 0, error: "fixture deletion failed" };
    } else {
      value = { success: true, deleted_count: 1, memory_id: "fixture-memory" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    })}\n`);

    const jsonResult = await runCli(
      ["memory", "forget", "fixture-memory", "--yes", "--json"],
      { ...process.env, PI67_HY_MEMORY_HOME: home },
    );
    assert.equal(jsonResult.code, 0, jsonResult.stderr || jsonResult.stdout);
    const forgotten = JSON.parse(jsonResult.stdout);
    assert.equal(forgotten.activeDeleted, true);
    assert.equal(forgotten.purgeComplete, false);
    assert.deepEqual(new Set(forgotten.retainedCopies), new Set([
      "history",
      "pipeline-trace",
      "pipeline-log",
      "reset-backups",
    ]));

    const textResult = await runCli(
      ["memory", "forget", "fixture-memory", "--yes"],
      { ...process.env, PI67_HY_MEMORY_HOME: home },
    );
    assert.equal(textResult.code, 0, textResult.stderr || textResult.stdout);
    assert.match(textResult.stdout, /deleted 1 active memory item\(s\); historical\/debug copies may remain/);

    const failed = await runCli(
      ["memory", "forget", "failure-memory", "--yes"],
      { ...process.env, PI67_HY_MEMORY_HOME: home },
    );
    assert.equal(failed.code, 1, failed.stderr || failed.stdout);
    assert.match(failed.stderr, /active memory deletion reported success=false: fixture deletion failed/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("memory mutation commands expose RUNNING and UNKNOWN receipts without claiming completion", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-operation-receipt-cli-"));
  const paths = memoryPaths(home);
  const token = "test-only-service-token-for-operation-receipt";
  const instanceId = "operation-receipt-instance";
  const server = http.createServer((request, response) => {
    let value;
    let status = 200;
    if (request.url === "/v1/info") {
      value = {
        schema: "pi67-hy-memory-service/v1",
        pid: process.pid,
        instanceId,
        root: paths.root,
        dataDir: paths.dataDir,
      };
    } else if (request.url === "/v1/digest") {
      value = operationReceipt("digest", "RUNNING", "8");
      status = 202;
    } else {
      value = operationReceipt("forget", "UNKNOWN", "9");
      status = 409;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeInitializedFixture(paths, token);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const ownership = {
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId,
      root: paths.root,
      dataDir: paths.dataDir,
    };
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify(ownership)}\n`);
    fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify(ownership)}\n`);

    const forgotten = await runCli(
      ["memory", "forget", "fixture-memory", "--yes", "--json"],
      { ...process.env, PI67_HY_MEMORY_HOME: home },
    );
    assert.equal(forgotten.code, 1, forgotten.stderr || forgotten.stdout);
    assert.equal(forgotten.stderr, "");
    const unknown = JSON.parse(forgotten.stdout);
    assert.equal(unknown.state, "UNKNOWN");
    assert.equal("activeDeleted" in unknown, false);

    const digested = await runCli(
      ["memory", "digest", "--yes", "--json", "--timeout-ms", "1000"],
      { ...process.env, PI67_HY_MEMORY_HOME: home },
    );
    assert.equal(digested.code, 1, digested.stderr || digested.stdout);
    assert.equal(JSON.parse(digested.stdout).state, "RUNNING");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function writeInitializedFixture(paths, token) {
  const wrapper = fs.readFileSync(serviceScript);
  const wrapperSha256 = crypto.createHash("sha256").update(wrapper).digest("hex");
  const generation = path.join(
    paths.runtimeDir,
    `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}`,
  );
  const python = process.platform === "win32"
    ? path.join(generation, "venv", "Scripts", "python.exe")
    : path.join(generation, "venv", "bin", "python");
  const installedServiceScript = path.join(generation, "service.py");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "fixture-python");
  fs.writeFileSync(installedServiceScript, wrapper);
  fs.writeFileSync(paths.configFile, `${JSON.stringify(defaultMemoryConfig("fixture-user"))}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.secretsFile, `${JSON.stringify({
    schema: "pi67-hy-memory-secrets/v1",
    embeddingApiKey: "test-only-embedding-credential",
    serviceBearerToken: token,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
    schema: "pi67-hy-memory-runtime/v1",
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python,
    serviceScript: installedServiceScript,
    wrapperSha256,
    wheelSha256: HY_MEMORY_WHEEL_SHA256,
    installedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return { generation, python, serviceScript: installedServiceScript, wrapperSha256 };
}

function operationReceipt(kind, state, digit) {
  const operationId = digit.repeat(64);
  return {
    schema: "pi67-hy-memory-operation/v1",
    operationId,
    kind,
    state,
    mutating: true,
    retryable: false,
    statusPath: `/v1/operations/${operationId}`,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
