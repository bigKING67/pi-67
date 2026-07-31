import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HyMemoryOperationPendingError,
  HyMemoryServiceClient,
} from "../../../extensions/pi-hy-memory/client.ts";
import { resolveHyMemoryPaths } from "../../../extensions/pi-hy-memory/config.ts";
import { defaultMemoryConfig } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

test("client preserves operation receipts and separates service wait from transport timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-client-operation-"));
  const paths = resolveHyMemoryPaths(root);
  const token = "test-only-client-operation-token";
  let mode = "delayed-search";
  let observedTimeout = "";
  let digestOperationId = "";
  const server = http.createServer(async (request, response) => {
    observedTimeout = String(request.headers["x-pi67-timeout-ms"] || "");
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (mode === "delayed-search") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      sendJson(response, 200, { memories: { normal: [] } });
      return;
    }
    if (mode === "search-running") {
      sendJson(response, 202, receipt("search", "RUNNING", "1"));
      return;
    }
    if (mode === "forget-unknown") {
      sendJson(response, 409, receipt("forget", "UNKNOWN", "2"));
      return;
    }
    if (mode === "digest-running") {
      digestOperationId = JSON.parse(body).operationId;
      sendJson(response, 202, receipt("digest", "RUNNING", "3"));
      return;
    }
    sendJson(response, 500, { error: "unexpected fixture mode" });
  });
  try {
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(paths.secretsFile, `${JSON.stringify({
      schema: "pi67-hy-memory-secrets/v1",
      embeddingApiKey: "test-only-embedding-key",
      serviceBearerToken: token,
    })}\n`);
    fs.writeFileSync(paths.serviceFile, `${JSON.stringify({
      schema: "pi67-hy-memory-service/v1",
      pid: process.pid,
      port: address.port,
      instanceId: "client-operation-instance",
      root: paths.root,
      dataDir: paths.dataDir,
      sdkVersion: "1.2.20",
      startedAt: "2026-07-31T00:00:00.000Z",
    })}\n`);
    const client = new HyMemoryServiceClient(defaultMemoryConfig("client-operation-user"), paths);

    const delayed = await client.search("delayed", 100);
    assert.deepEqual(delayed, { memories: { normal: [] } });
    assert.equal(observedTimeout, "100");

    mode = "search-running";
    await assert.rejects(
      client.search("pending", 100),
      (error) => error instanceof HyMemoryOperationPendingError
        && error.receipt.state === "RUNNING"
        && error.receipt.operationId === "1".repeat(64),
    );

    mode = "forget-unknown";
    const forgotten = await client.forget("fixture-memory");
    assert.equal(forgotten.state, "UNKNOWN");
    assert.equal(forgotten.operationId, "2".repeat(64));
    assert.equal("activeDeleted" in forgotten, false);

    mode = "digest-running";
    const digest = await client.digest();
    assert.equal(digest.state, "RUNNING");
    assert.match(digestOperationId, /^[a-f0-9]{64}$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function receipt(kind, state, digit) {
  const operationId = digit.repeat(64);
  return {
    schema: "pi67-hy-memory-operation/v1",
    operationId,
    kind,
    state,
    mutating: kind !== "search",
    retryable: false,
    statusPath: `/v1/operations/${operationId}`,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
