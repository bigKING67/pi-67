import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import {
  defaultMemoryConfig,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  memoryPaths,
  memoryStatus,
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
    const status = spawnSync(process.execPath, [cli, "memory", "status", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI67_HY_MEMORY_HOME: home },
    });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.initialized, false);
    assert.deepEqual(payload.nextSteps, ["pi-67 memory init"]);
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
  const defaultPiBin = path.join(root, "npm", "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const piBin = process.env.PI67_HY_MEMORY_PI_BIN || defaultPiBin;
  const toolNames = ["hy_memory_search", "hy_memory_add", "hy_memory_list", "hy_memory_forget"];
  const result = spawnSync(piBin, [
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
    shell: process.platform === "win32",
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

test("destructive memory commands fail closed without --yes", () => {
  for (const args of [["forget", "memory-id"], ["digest"], ["reset"]]) {
    const result = spawnSync(process.execPath, [cli, "memory", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /requires --yes|permanent deletion requires --yes/);
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
    fs.writeFileSync(paths.configFile, `${JSON.stringify(defaultMemoryConfig("path-alias-user"))}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.secretsFile, `${JSON.stringify({
      schema: "pi67-hy-memory-secrets/v1",
      embeddingApiKey: "test-only-embedding-credential",
      serviceBearerToken: token,
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
      schema: "pi67-hy-memory-runtime/v1",
      sdkVersion: HY_MEMORY_SDK_VERSION,
      python: process.execPath,
      serviceScript,
      wheelSha256: HY_MEMORY_WHEEL_SHA256,
      installedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
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

function writeInitializedFixture(paths, token) {
  fs.writeFileSync(paths.configFile, `${JSON.stringify(defaultMemoryConfig("fixture-user"))}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.secretsFile, `${JSON.stringify({
    schema: "pi67-hy-memory-secrets/v1",
    embeddingApiKey: "test-only-embedding-credential",
    serviceBearerToken: token,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
    schema: "pi67-hy-memory-runtime/v1",
    sdkVersion: HY_MEMORY_SDK_VERSION,
    python: process.execPath,
    serviceScript,
    wheelSha256: HY_MEMORY_WHEEL_SHA256,
    installedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
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
