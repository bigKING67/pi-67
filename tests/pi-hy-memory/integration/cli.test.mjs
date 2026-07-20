import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import {
  defaultMemoryConfig,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  memoryPaths,
  memoryStatus,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "packages", "pi67-cli", "bin", "pi-67.mjs");
const serviceScript = path.join(root, "extensions", "pi-hy-memory", "service.py");

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

    const status = await memoryStatus({ agentDir: root }, { home });
    assert.equal(status.running, true);
    assert.equal(status.checks.find((item) => item.id === "service")?.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
