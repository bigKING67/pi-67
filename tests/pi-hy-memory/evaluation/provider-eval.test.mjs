import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultMemoryConfig, memoryPaths } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";
import {
  ProviderEvaluationError,
  prepareProviderEvaluationHome,
  runProviderEvaluation,
  validateProviderEvaluationEnvironment,
} from "./provider-eval.mjs";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "golden-cases.json"), "utf8"));
const providerEvalScript = path.join(import.meta.dirname, "provider-eval.mjs");

test("provider evaluation requires explicit network and synthetic-corpus opt-ins before using a client", async () => {
  let clientUsed = false;
  await assert.rejects(
    runProviderEvaluation({
      env: {},
      fixture,
      client: { info: async () => { clientUsed = true; } },
    }),
    (error) => error instanceof ProviderEvaluationError && error.code === "network-opt-in-required",
  );
  assert.equal(clientUsed, false);
});

test("provider evaluation command is offline and sanitized by default", () => {
  const env = { ...process.env };
  delete env.PI67_HY_MEMORY_EVAL_ALLOW_NETWORK;
  delete env.PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY;
  delete env.PI67_HY_MEMORY_EVAL_HOME;
  const result = spawnSync(process.execPath, ["--no-warnings", providerEvalScript], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    schema: "pi67.hy-memory-provider-evaluation-error/v1",
    passed: false,
    errorKind: "network-opt-in-required",
  });
});

test("provider evaluation command prepares only an explicit empty home without network opt-in", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-provider-prepare-command-"));
  try {
    const env = { ...process.env };
    delete env.PI67_HY_MEMORY_EVAL_ALLOW_NETWORK;
    env.PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY = "1";
    env.PI67_HY_MEMORY_EVAL_HOME = home;
    const result = spawnSync(process.execPath, ["--no-warnings", providerEvalScript, "--prepare-home"], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).prepared, true);
    assert.deepEqual(fs.readdirSync(home), [".pi67-hy-memory-provider-evaluation.json"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("provider evaluation refuses the live home and any overlapping path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-provider-home-"));
  try {
    const liveHome = path.join(root, "live");
    const nested = path.join(liveHome, "evaluation");
    fs.mkdirSync(nested, { recursive: true });
    assert.throws(
      () => validateProviderEvaluationEnvironment({
        PI67_HY_MEMORY_EVAL_ALLOW_NETWORK: "1",
        PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
        PI67_HY_MEMORY_EVAL_HOME: nested,
      }, { liveHome }),
      (error) => error instanceof ProviderEvaluationError && error.code === "live-home-forbidden",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider evaluation refuses a caller-supplied noncanonical corpus before contacting a service", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-provider-corpus-"));
  try {
    prepareProviderEvaluationHome({
      PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
      PI67_HY_MEMORY_EVAL_HOME: home,
    });
    let clientUsed = false;
    await assert.rejects(
      runProviderEvaluation({
        env: {
          PI67_HY_MEMORY_EVAL_ALLOW_NETWORK: "1",
          PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
          PI67_HY_MEMORY_EVAL_HOME: home,
        },
        fixture: { ...fixture, memoryItems: [...fixture.memoryItems, { id: "unexpected", content: "unexpected", status: "active" }] },
        client: { info: async () => { clientUsed = true; } },
      }),
      (error) => error instanceof ProviderEvaluationError && error.code === "noncanonical-evaluation-fixture",
    );
    assert.equal(clientUsed, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("provider evaluation uses only an empty isolated home and emits sanitized synthetic metrics", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-provider-eval-"));
  const paths = memoryPaths(home);
  const token = "fixture-bearer-token-not-a-secret";
  const instanceId = "provider-evaluation-fixture";
  const capturedBodies = [];
  const seededProviderIds = [];
  const prepared = prepareProviderEvaluationHome({
    PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
    PI67_HY_MEMORY_EVAL_HOME: home,
  });
  assert.deepEqual(prepared, {
    schema: "pi67.hy-memory-provider-evaluation-home/v1",
    prepared: true,
    syntheticOnly: true,
    fixtureSha256: prepared.fixtureSha256,
  });
  assert.throws(
    () => prepareProviderEvaluationHome({
      PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
      PI67_HY_MEMORY_EVAL_HOME: home,
    }),
    (error) => error instanceof ProviderEvaluationError && error.code === "evaluation-home-not-empty",
  );
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (request.headers.authorization !== `Bearer ${token}`) return sendJson(response, 401, { error: "forbidden" });
    if (request.url === "/v1/info") {
      return sendJson(response, 200, {
        schema: "pi67-hy-memory-service/v1",
        instanceId,
        pid: process.pid,
        root: paths.root,
        dataDir: paths.dataDir,
        sdkVersion: "1.2.20",
        mode: "pro",
        vectorDimensions: 1024,
      });
    }
    if (request.url?.startsWith("/v1/memories?")) {
      return sendJson(response, 200, {
        vdb: {
          memories: seededProviderIds.map((memoryId) => ({ memory_id: memoryId, content: "provider-normalized" })),
          total: seededProviderIds.length,
        },
      });
    }
    if (request.url === "/v1/capture") {
      capturedBodies.push(body);
      const marker = /\[PI67-EVAL-ID:([a-z0-9._-]+)\]/u.exec(JSON.stringify(body));
      assert.ok(marker, "capture fixture must carry its synthetic evaluation marker");
      const memoryId = providerMemoryId(marker[1]);
      seededProviderIds.push(memoryId);
      return sendJson(response, 200, { success: true, memory_id: `raw-${memoryId}` });
    }
    if (request.url === "/v1/search") {
      const ids = expectedIdsForQuery(body.query);
      return sendJson(response, 200, {
        memories: {
          normal: ids.map((id) => ({
            memory_id: providerMemoryId(id),
            content: "provider-normalized-without-evaluation-markers",
            score: 0.99,
          })),
        },
      });
    }
    return sendJson(response, 404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const config = defaultMemoryConfig("provider-evaluation-user");
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.configFile, `${JSON.stringify(config)}\n`);
  fs.writeFileSync(paths.secretsFile, `${JSON.stringify({
    schema: "pi67-hy-memory-secrets/v1",
    embeddingApiKey: "fixture-embedding-key-not-a-secret",
    serviceBearerToken: token,
  })}\n`, { mode: 0o600 });
  const ownership = {
    schema: "pi67-hy-memory-service/v1",
    pid: process.pid,
    port: server.address().port,
    instanceId,
    root: paths.root,
    dataDir: paths.dataDir,
  };
  fs.writeFileSync(paths.serviceFile, `${JSON.stringify(ownership)}\n`);
  fs.writeFileSync(paths.lifetimeOwnerFile, `${JSON.stringify(ownership)}\n`);

  const result = await runProviderEvaluation({
    fixture,
    env: {
      PI67_HY_MEMORY_EVAL_ALLOW_NETWORK: "1",
      PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY: "1",
      PI67_HY_MEMORY_EVAL_HOME: home,
    },
  });
  assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  assert.equal(result.mode, "isolated-provider");
  assert.equal(result.semanticQualityClaim, true);
  assert.equal(result.corpusScope, "isolated-synthetic");
  assert.equal(result.resources.adapterRequests, 4);
  assert.equal(result.resources.serviceRequests, 12);
  assert.equal(result.resources.providerOperationRequests, 7);
  assert.equal(result.resources.externalProviderRequests, null);
  assert.equal(result.resources.estimatedCostUsd, null);
  assert.equal(capturedBodies.length, 3, "only active recall-eligible fixture memories are seeded");
  const serializedCaptures = JSON.stringify(capturedBodies);
  assert.doesNotMatch(serializedCaptures, /synthetic-secret|sk-fixture-not-a-real-secret/);
  const serializedResult = JSON.stringify(result);
  assert.doesNotMatch(serializedResult, /sk-fixture-not-a-real-secret|fixture-bearer-token|fixture-embedding-key/);
  assert.doesNotMatch(serializedResult, /What language does the user prefer/);
});

function expectedIdsForQuery(query) {
  if (/language/i.test(query)) return ["language-current"];
  if (/monorepo/i.test(query)) return ["repository-boundary"];
  if (/editor/i.test(query)) return ["editor-current"];
  return [];
}

function providerMemoryId(fixtureId) {
  return `provider-memory-${fixtureId}`;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
