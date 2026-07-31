import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { defaultMemoryConfig } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const serviceScript = path.join(root, "extensions", "pi-hy-memory", "service.py");

test("loopback wrapper requires bearer auth and reports the real vector dimensions", async (t) => {
  const python = findPython();
  if (!python) return t.skip("Python is unavailable on this host");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-service-"));
  const fakeRoot = path.join(tmp, "fake-sdk");
  const stateRoot = path.join(tmp, "state");
  const token = "test-only-loopback-bearer-token-value";
  let child;
  let childStderr = "";
  try {
    fs.mkdirSync(path.join(fakeRoot, "hy_memory"), { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "hy_memory", "__init__.py"), fakeSdk(), "utf8");
    fs.writeFileSync(path.join(stateRoot, "config.json"), `${JSON.stringify(defaultMemoryConfig("user-fixture"))}\n`, "utf8");
    child = spawn(python.command, [...python.prefix, serviceScript, "--root", stateRoot, "--port", "0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: fakeRoot,
        PI67_HY_MEMORY_SERVICE_TOKEN: token,
        PI67_HY_MEMORY_LLM_API_KEY: "test-only-llm-credential",
        PI67_HY_MEMORY_EMBEDDING_API_KEY: "test-only-embedding-credential",
        PI67_HY_MEMORY_TEST_STARTUP_TRACE: "1",
        MEMORY_DATA_DIR: path.join(stateRoot, "data"),
      },
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      childStderr += chunk;
    });
    const service = await waitForJson(
      path.join(stateRoot, "runtime", "service.json"),
      30_000,
      child,
      () => childStderr,
    );
    const base = `http://127.0.0.1:${service.port}`;

    const unauthorized = await fetch(`${base}/v1/info`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${token}` };
    const info = await fetchJson(`${base}/v1/info`, { headers });
    assert.equal(info.schema, "pi67-hy-memory-service/v1");
    assert.equal(info.instanceId, service.instanceId);
    assert.equal(info.vectorDimensions, 1024);
    assert.deepEqual(info.storagePolicy, {
      codingMemoryEnabled: false,
      historyAuditEnabled: false,
      memoryOperationsEnabled: false,
      pipelineDbTraceEnabled: false,
      legacyRequestTraceEnabled: false,
      pipelineJsonlEnabled: true,
      pipelineJsonlControl: "sdk-1.2.20-always-on",
      fullPurgeSupported: false,
    });

    const second = spawnSync(python.command, [...python.prefix, serviceScript, "--root", stateRoot, "--port", "0"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PYTHONPATH: fakeRoot,
        PI67_HY_MEMORY_SERVICE_TOKEN: token,
        PI67_HY_MEMORY_LLM_API_KEY: "test-only-llm-credential",
        PI67_HY_MEMORY_EMBEDDING_API_KEY: "test-only-embedding-credential",
        MEMORY_DATA_DIR: path.join(stateRoot, "data"),
      },
    });
    assert.notEqual(second.status, 0, "a second service unexpectedly acquired the same state root");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, "runtime", "service.json"), "utf8")).instanceId, service.instanceId);

    const probe = await fetchJson(`${base}/v1/probe`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(probe.vectorDimensions, 1024);
    assert.equal(probe.finite, true);

    const capture = await fetchJson(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-fixture",
        messages: [{ role: "user", content: "Remember this fixture" }],
      }),
    });
    assert.equal(capture.success, true);

    const forgotten = await fetchJson(`${base}/v1/memories/fixture-memory`, {
      method: "DELETE",
      headers,
    });
    assert.equal(forgotten.success, true);
    assert.equal(forgotten.deleted_count, 1);
    assert.equal(forgotten.activeDeleted, true);
    assert.equal(forgotten.purgeComplete, false);
    assert.deepEqual(new Set(forgotten.retainedCopies), new Set([
      "history",
      "pipeline-trace",
      "pipeline-log",
      "reset-backups",
    ]));

    const missing = await fetchJson(`${base}/v1/memories/missing-memory`, {
      method: "DELETE",
      headers,
    });
    assert.equal(missing.deleted_count, 0);
    assert.equal(missing.activeDeleted, false);
    assert.equal(missing.purgeComplete, false);

    const serial = await Promise.all(["slow-one", "slow-two"].map((query) => fetchJson(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "1500" },
      body: JSON.stringify({ query }),
    })));
    assert.deepEqual(serial.map((value) => value.maxActive), [1, 1]);

    const deadlineStarted = Date.now();
    const timedOut = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "100" },
      body: JSON.stringify({ query: "slow-deadline" }),
    });
    assert.equal(timedOut.status, 202);
    const timedOutReceipt = await timedOut.json();
    assert.equal(timedOutReceipt.schema, "pi67-hy-memory-operation/v1");
    assert.equal(timedOutReceipt.state, "RUNNING");
    assert.equal(timedOutReceipt.retryable, false);
    const timedOutTerminal = await waitForOperation(base, timedOutReceipt.statusPath, headers);
    assert.equal(timedOutTerminal.state, "SUCCEEDED");
    const afterTimeout = await fetchJson(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "1500" },
      body: JSON.stringify({ query: "after-timeout" }),
    });
    assert.equal(afterTimeout.maxActive, 1);
    assert.ok(Date.now() - deadlineStarted >= 180, "the started SDK call should finish on the sole worker before queued work");

    const blockingSearch = fetchJson(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "1500" },
      body: JSON.stringify({ query: "slow-queued-mutation-blocker" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const queuedRequestId = "4".repeat(64);
    const queuedCapture = await fetch(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "100" },
      body: JSON.stringify({
        sessionId: "queued-capture",
        requestId: queuedRequestId,
        messages: [{ role: "user", content: "queued-capture" }],
      }),
    });
    assert.equal(queuedCapture.status, 504);
    const queuedReceipt = await queuedCapture.json();
    assert.equal(queuedReceipt.state, "FAILED");
    assert.equal(queuedReceipt.retryable, true);
    assert.equal(queuedReceipt.error.code, "deadline-before-start");
    await blockingSearch;
    let mutationCounts = await fetchJson(`${base}/v1/memories?limit=1&offset=0`, { headers });
    assert.equal(mutationCounts.captureCalls, 1, "the earlier normal capture is the only completed capture");
    const queuedRetry = await fetchJson(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "1500" },
      body: JSON.stringify({
        sessionId: "queued-capture",
        requestId: queuedRequestId,
        messages: [{ role: "user", content: "queued-capture" }],
      }),
    });
    assert.equal(queuedRetry.success, true);

    const slowCaptureBody = {
      sessionId: "late-capture",
      requestId: "5".repeat(64),
      messages: [{ role: "user", content: "slow-capture" }],
    };
    const slowCapture = await fetch(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "100" },
      body: JSON.stringify(slowCaptureBody),
    });
    assert.equal(slowCapture.status, 202);
    const slowCaptureReceipt = await slowCapture.json();
    assert.equal(slowCaptureReceipt.state, "RUNNING");
    assert.equal((await waitForOperation(base, slowCaptureReceipt.statusPath, headers)).state, "SUCCEEDED");
    assert.equal((await fetchJson(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(slowCaptureBody),
    })).success, true);

    const unknownCaptureBody = {
      sessionId: "unknown-capture",
      requestId: "6".repeat(64),
      messages: [{ role: "user", content: "unknown-capture private payload" }],
    };
    const unknownCapture = await fetch(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(unknownCaptureBody),
    });
    assert.equal(unknownCapture.status, 409);
    const unknownReceipt = await unknownCapture.json();
    assert.equal(unknownReceipt.state, "UNKNOWN");
    assert.equal(unknownReceipt.retryable, false);
    const unknownReplay = await fetch(`${base}/v1/capture`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(unknownCaptureBody),
    });
    assert.equal(unknownReplay.status, 409);

    const slowForget = await fetch(`${base}/v1/memories/slow-forget`, {
      method: "DELETE",
      headers: { ...headers, "x-pi67-timeout-ms": "100" },
    });
    assert.equal(slowForget.status, 202);
    const slowForgetReceipt = await slowForget.json();
    assert.equal((await waitForOperation(base, slowForgetReceipt.statusPath, headers)).state, "SUCCEEDED");
    assert.equal((await fetchJson(`${base}/v1/memories/slow-forget`, { method: "DELETE", headers })).success, true);

    const digestOperationId = "7".repeat(64);
    const slowDigest = await fetch(`${base}/v1/digest`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "100" },
      body: JSON.stringify({ operationId: digestOperationId }),
    });
    assert.equal(slowDigest.status, 202);
    const slowDigestReceipt = await slowDigest.json();
    const competingDigest = await fetch(`${base}/v1/digest`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "100" },
      body: JSON.stringify({ operationId: "8".repeat(64) }),
    });
    assert.equal(competingDigest.status, 202);
    const competingDigestReceipt = await competingDigest.json();
    assert.equal(competingDigestReceipt.operationId, slowDigestReceipt.operationId);
    assert.equal(competingDigestReceipt.state, "RUNNING");
    assert.equal((await waitForOperation(base, slowDigestReceipt.statusPath, headers)).state, "SUCCEEDED");
    assert.equal((await fetchJson(`${base}/v1/digest`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ operationId: digestOperationId }),
    })).success, true);

    mutationCounts = await fetchJson(`${base}/v1/memories?limit=1&offset=0`, { headers });
    assert.equal(mutationCounts.captureCalls, 4);
    assert.equal(mutationCounts.deleteCalls, 3);
    assert.equal(mutationCounts.digestCalls, 1);
    const operationFiles = fs.readdirSync(path.join(stateRoot, "operations"));
    const operationLedgerText = operationFiles
      .map((file) => fs.readFileSync(path.join(stateRoot, "operations", file), "utf8"))
      .join("\n");
    assert.doesNotMatch(operationLedgerText, /unknown-capture private payload/);

    const saturated = await Promise.all(Array.from({ length: 24 }, (_, index) => fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "2500" },
      body: JSON.stringify({ query: `slow-capacity-${index}` }),
    })));
    assert.ok(saturated.some((response) => response.status === 503), "bounded HTTP handler capacity did not reject overflow");

    const sensitiveQuery = [
      "find the ordinary fixture text",
      "Authorization: Bearer fixture-search-bearer-token-123456",
      "api_key='fixture-search-api-key-123456'",
    ].join("\n");
    const sanitizedSearch = await fetchJson(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query: sensitiveQuery }),
    });
    assert.match(sanitizedSearch.observedQuery, /find the ordinary fixture text/);
    assert.match(sanitizedSearch.observedQuery, /\[REDACTED/);
    assert.doesNotMatch(
      sanitizedSearch.observedQuery,
      /fixture-search-bearer-token-123456|fixture-search-api-key-123456/,
    );

    const privateQuery = "private-http-error-fixture";
    const failedSearch = await fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query: privateQuery }),
    });
    assert.equal(failedSearch.status, 500);
    assert.deepEqual(await failedSearch.json(), { error: "internal server error" });

    await fetchJson(`${base}/v1/shutdown`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(await waitForExit(child, 30_000), 0);
    assert.equal(fs.existsSync(path.join(stateRoot, "runtime", "service.json")), false);
    assert.equal(fs.existsSync(path.join(stateRoot, "runtime", "service-owner.json")), false);
    assert.equal(fs.readFileSync(path.join(stateRoot, "logs", "service.log"), "utf8").includes(privateQuery), false);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbox retries use exponential backoff without persisting message text in errors", (t) => {
  const python = findPython();
  if (!python) return t.skip("Python is unavailable on this host");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-retry-"));
  try {
    const result = spawnSync(
      python.command,
      [...python.prefix, "-c", outboxRetryProbe(), serviceScript, tmp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.attempts, 1);
    assert.equal(value.messageLeaked, false);
    assert.equal(value.skippedBeforeDue, true);
    assert.equal(value.eligibleAfterDue, 1);
    assert.equal(value.loopbackBindAvoidedFqdn, true);
    assert.ok(value.dueInSeconds >= 4 && value.dueInSeconds <= 6.5, value.dueInSeconds);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outbox recovery preserves retry metadata and batches each session by createdAt then requestId", (t) => {
  const python = findPython();
  if (!python) return t.skip("Python is unavailable on this host");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-ordering-"));
  try {
    const result = spawnSync(
      python.command,
      [...python.prefix, "-c", outboxOrderingRecoveryProbe(), serviceScript, tmp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.recoveredAttempts, 2);
    assert.equal(value.processingRemoved, true);
    assert.deepEqual(value.capturedOrder, ["earliest", "tie-a", "tie-c"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("operation recovery marks started mutations UNKNOWN and parks unresolved outbox jobs", (t) => {
  const python = findPython();
  if (!python) return t.skip("Python is unavailable on this host");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-operation-recovery-"));
  try {
    const result = spawnSync(
      python.command,
      [...python.prefix, "-c", operationRecoveryProbe(), serviceScript, tmp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.queuedState, "FAILED");
    assert.equal(value.queuedRetryable, true);
    assert.equal(value.runningState, "UNKNOWN");
    assert.equal(value.runningRetryable, false);
    assert.equal(value.captureCalls, 0);
    assert.equal(value.unknownParked, true);
    assert.equal(value.legacyParked, true);
    assert.equal(value.succeededRemoved, true);
    assert.equal(value.unresolved, 2);
    assert.equal(value.flushSuccess, false);
    assert.equal(value.flushFast, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ledger write failures never execute before RUNNING and never report unrecorded success", (t) => {
  const python = findPython();
  if (!python) return t.skip("Python is unavailable on this host");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-ledger-failure-"));
  try {
    const result = spawnSync(
      python.command,
      [...python.prefix, "-c", operationLedgerFailureProbe(), serviceScript, tmp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.runningWriteSdkCalls, 0);
    assert.equal(value.runningWriteState, "FAILED");
    assert.equal(value.runningWriteRetryable, true);
    assert.equal(value.terminalWriteSdkCalls, 1);
    assert.equal(value.terminalWriteCurrentState, "UNKNOWN");
    assert.equal(value.terminalWriteRestartState, "UNKNOWN");
    assert.equal(value.terminalWriteRetryable, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function findPython() {
  const actionPythonRoots = [process.env.pythonLocation, process.env.Python3_ROOT_DIR]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const actionPythonCandidates = actionPythonRoots.map((root) => ({
    command: process.platform === "win32" ? path.join(root, "python.exe") : path.join(root, "bin", "python3"),
    prefix: [],
  }));
  for (const candidate of [
    ...actionPythonCandidates,
    { command: "python3", prefix: [] },
    { command: "python", prefix: [] },
    { command: "py", prefix: ["-3.11"] },
  ]) {
    const result = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && !result.error) return candidate;
  }
  return null;
}

async function waitForJson(file, timeoutMs, child, diagnostics = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (child.exitCode !== null) {
      throw new Error(`service exited early with ${child.exitCode}: ${await streamText(child.stderr)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = diagnostics().trim();
  throw new Error(`service metadata timeout${detail ? `: ${detail}` : ""}`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  assert.equal(response.ok, true, `${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child exit timeout")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForOperation(base, statusPath, headers, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}${statusPath}`, { headers });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    if (["SUCCEEDED", "FAILED", "UNKNOWN"].includes(receipt.state)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`operation did not reach a terminal state: ${statusPath}`);
}

async function streamText(stream) {
  let value = "";
  for await (const chunk of stream) value += String(chunk);
  return value;
}

function fakeSdk() {
  return `import asyncio
import os
import time

__version__ = "1.2.20"

class _Box:
    pass

class MemoryConfig:
    @classmethod
    def from_dict(cls, value):
        result = _Box()
        result.vector_store = _Box()
        result.vector_store.embedding_dims = value["vector_store"]["embedding_dims"]
        result.coding = _Box()
        result.coding.enable = os.environ["MEMORY_CODING_ENABLED"] != "false"
        result.history = _Box()
        result.history.enable = value["history"]["enable"]
        result.history_enabled = value["history"]["enable"]
        return result

class _Loop:
    def run(self, coroutine):
        return asyncio.run(coroutine)

class _Embed:
    async def embed(self, _value):
        return [0.0] * 1024

class HyMemoryClient:
    active = 0
    max_active = 0
    capture_calls = 0
    delete_calls = 0
    digest_calls = 0

    def __init__(self, config=None, mode="pro"):
        assert config.history_enabled is False
        assert os.environ["MEMORY_CODING_ENABLED"] == "false"
        assert os.environ["MEMORY_HISTORY_ENABLE"] == "false"
        assert os.environ["MEMORY_MEMORY_OPERATIONS_ENABLED"] == "false"
        assert os.environ["MEMORY_PIPELINE_TRACE_ENABLED"] == "false"
        assert os.environ["MEMORY_TRACE_ENABLED"] == "false"
        self.config = config
        self.mode = mode
        self._loop_thread = _Loop()
        self._embed_service = _Embed()

    def add(self, messages, **kwargs):
        type(self).capture_calls += 1
        content = " ".join(message.get("content", "") for message in messages)
        if "slow-capture" in content:
            time.sleep(0.75)
        if "unknown-capture" in content:
            raise RuntimeError(f"provider echoed {content}")
        return {"success": True, "memory_id": "fixture-memory", "request_id": kwargs.get("request_id")}

    def search(self, query, **kwargs):
        if query == "private-http-error-fixture":
            raise RuntimeError(f"provider echoed {query}")
        type(self).active += 1
        type(self).max_active = max(type(self).max_active, type(self).active)
        try:
            if query.startswith("slow-"):
                time.sleep(0.2)
            return {
                "memories": {"normal": [{"content": "fixture memory", "score": 0.9}]},
                "maxActive": type(self).max_active,
                "observedQuery": query,
            }
        finally:
            type(self).active -= 1

    def list_memories(self, **kwargs):
        return {
            "vdb": {"memories": [], "total": 0, "limit": kwargs.get("limit"), "offset": kwargs.get("offset")},
            "captureCalls": type(self).capture_calls,
            "deleteCalls": type(self).delete_calls,
            "digestCalls": type(self).digest_calls,
        }

    def get(self, memory_id):
        return {"memory_id": memory_id, "content": "fixture memory"}

    def delete(self, memory_id):
        type(self).delete_calls += 1
        if memory_id == "slow-forget":
            time.sleep(0.75)
        return {"success": True, "deleted_count": 0 if memory_id == "missing-memory" else 1, "memory_id": memory_id}

    def digest(self, **kwargs):
        type(self).digest_calls += 1
        time.sleep(0.75)
        return {"success": True, "tasks_processed": 1}

    def close(self):
        return None
`;
}

function outboxOrderingRecoveryProbe() {
  return String.raw`import importlib.util
import json
import sys
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_service_ordering_test", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

paths = service.StatePaths(root)
paths.ensure()
config = {
    "userId": "user-fixture",
    "agentId": "pi-67",
    "capture": {"maxAttempts": 5, "batchTurns": 5, "maxDelayMs": 60000},
}
request_id = "d" * 64
processing = {
    "schema": service.OUTBOX_SCHEMA,
    "requestId": request_id,
    "userId": "user-fixture",
    "agentId": "pi-67",
    "sessionId": "session-recovery",
    "messages": [{"role": "user", "content": "stale"}],
    "attempts": 0,
    "createdAt": "2026-07-30T00:00:00+00:00",
    "updatedAt": "2026-07-30T00:00:00+00:00",
}
pending = {**processing, "attempts": 2, "updatedAt": "2026-07-30T00:02:00+00:00", "nextAttemptAt": "2026-07-30T00:03:00+00:00"}
service.write_json_atomic(paths.processing_dir / f"{request_id}.json", processing)
service.write_json_atomic(paths.pending_dir / f"{request_id}.json", pending)

class Holder:
    def __init__(self):
        self.captured = []
    def capture(self, messages, _session_id, _request_id):
        self.captured.extend(message["content"] for message in messages)
        return {"success": True}

holder = Holder()
processor = service.OutboxProcessor(paths, config, holder)
recovered = service.read_json_object(paths.pending_dir / f"{request_id}.json")
(paths.pending_dir / f"{request_id}.json").unlink()

jobs = [
    ("a" * 64, "2026-07-30T00:00:02+00:00", "tie-a"),
    ("b" * 64, "2026-07-30T00:00:01+00:00", "earliest"),
    ("c" * 64, "2026-07-30T00:00:02+00:00", "tie-c"),
]
for item_id, created_at, content in jobs:
    service.write_json_atomic(paths.pending_dir / f"{item_id}.json", {
        "schema": service.OUTBOX_SCHEMA,
        "requestId": item_id,
        "userId": "user-fixture",
        "agentId": "pi-67",
        "sessionId": "session-ordering",
        "messages": [{"role": "user", "content": content}],
        "attempts": 0,
        "createdAt": created_at,
        "updatedAt": created_at,
    })
processor._drain(force=True)

print(json.dumps({
    "recoveredAttempts": recovered["attempts"],
    "processingRemoved": not (paths.processing_dir / f"{request_id}.json").exists(),
    "capturedOrder": holder.captured,
}))
`;
}

function outboxRetryProbe() {
  return String.raw`import datetime as dt
import importlib.util
import json
import socket
import sys
import time
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_service_test", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

original_getfqdn = socket.getfqdn
socket.getfqdn = lambda _host="": (_ for _ in ()).throw(RuntimeError("unexpected reverse DNS"))
try:
    server = service.LoopbackHTTPServer(("127.0.0.1", 0), service.BaseHTTPRequestHandler)
    loopback_bind_avoided_fqdn = server.server_name == "127.0.0.1" and server.server_port > 0
    server.server_close()
finally:
    socket.getfqdn = original_getfqdn

paths = service.StatePaths(root)
paths.ensure()
processor = service.OutboxProcessor(paths, {"capture": {"maxAttempts": 5}}, None)
request_id = "a" * 64
body = "private retry memory fixture"
job = {
    "schema": service.OUTBOX_SCHEMA,
    "requestId": request_id,
    "messages": [{"role": "user", "content": body}],
    "attempts": 0,
}

processing_file = paths.processing_dir / f"{request_id}.json"
service.write_json_atomic(processing_file, job)
started = time.time()
processor._retry_or_dead_letter(processing_file, job, RuntimeError(f"provider echoed {body}"))

pending_file = paths.pending_dir / processing_file.name
queued = service.read_json_object(pending_file)
due_in = service.parse_time(queued["nextAttemptAt"]) - started
skipped_before_due = processor._pending_jobs() == []
queued["nextAttemptAt"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
service.write_json_atomic(pending_file, queued)

print(json.dumps({
    "attempts": queued["attempts"],
    "messageLeaked": body in queued["lastError"],
    "dueInSeconds": due_in,
    "skippedBeforeDue": skipped_before_due,
    "eligibleAfterDue": len(processor._pending_jobs()),
    "loopbackBindAvoidedFqdn": loopback_bind_avoided_fqdn,
}))
`;
}

function operationRecoveryProbe() {
  return String.raw`import importlib.util
import json
import sys
import time
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_operation_recovery_test", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

paths = service.StatePaths(root)
paths.ensure()
old = service.OperationLedger(paths, "old-instance")
queued_id = service.stable_operation_id("capture", "queued")
running_id = service.stable_operation_id("capture", "running")
old.prepare(queued_id, "capture")
old.prepare(running_id, "capture")
old.transition(running_id, "RUNNING", retryable=False, startedAt=service.utc_now())

ledger = service.OperationLedger(paths, "new-instance")
queued = ledger.get(queued_id)
running = ledger.get(running_id)

class Holder:
    def __init__(self):
        self.capture_calls = 0
    def operation_receipt(self, operation_id):
        return ledger.get(operation_id)
    def capture(self, *_args):
        self.capture_calls += 1
        return {"success": True}

holder = Holder()
config = {
    "userId": "user-fixture",
    "agentId": "pi-67",
    "capture": {"maxAttempts": 5, "batchTurns": 5, "maxDelayMs": 60000},
}

def job(request_id, operation_id=None):
    value = {
        "schema": service.OUTBOX_SCHEMA,
        "requestId": request_id,
        "userId": "user-fixture",
        "agentId": "pi-67",
        "sessionId": "session-fixture",
        "messages": [{"role": "user", "content": "private fixture"}],
        "attempts": 0,
        "createdAt": service.utc_now(),
        "updatedAt": service.utc_now(),
    }
    if operation_id:
        value["operationId"] = operation_id
    return value

unknown_file = paths.processing_dir / f"{'8' * 64}.json"
legacy_file = paths.processing_dir / f"{'9' * 64}.json"
service.write_json_atomic(unknown_file, job("8" * 64, running_id))
service.write_json_atomic(legacy_file, job("9" * 64))

success_id = service.stable_operation_id("capture", "succeeded")
ledger.prepare(success_id, "capture")
ledger.transition(success_id, "RUNNING", retryable=False, startedAt=service.utc_now())
ledger.transition(success_id, "SUCCEEDED", retryable=False, result={"success": True}, resultAvailable=True)
success_file = paths.processing_dir / f"{'a' * 64}.json"
service.write_json_atomic(success_file, job("a" * 64, success_id))

processor = service.OutboxProcessor(paths, config, holder)
processor._drain(force=True)
started = time.monotonic()
flushed = processor.flush(timeout=1.0)
elapsed = time.monotonic() - started

print(json.dumps({
    "queuedState": queued["state"],
    "queuedRetryable": queued["retryable"],
    "runningState": running["state"],
    "runningRetryable": running["retryable"],
    "captureCalls": holder.capture_calls,
    "unknownParked": service.read_json_object(unknown_file).get("resolutionRequired") is True,
    "legacyParked": service.read_json_object(legacy_file).get("resolutionRequired") is True,
    "succeededRemoved": not success_file.exists(),
    "unresolved": processor.counts()["unresolved"],
    "flushSuccess": flushed["success"],
    "flushFast": elapsed < 0.5,
}))
`;
}

function operationLedgerFailureProbe() {
  return String.raw`import importlib.util
import json
import sys
import threading
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_ledger_failure_test", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

class FakeClient:
    def __init__(self):
        self.calls = 0
    def add(self, *_args, **_kwargs):
        self.calls += 1
        return {"success": True, "memory_id": "fixture"}
    def close(self):
        return None

service.ClientHolder._new_client = lambda self, _mode: FakeClient()
original_write = service.write_json_atomic

def run_case(case_root, failed_state, request_id):
    paths = service.StatePaths(case_root)
    paths.ensure()
    ledger = service.OperationLedger(paths, "instance-one")
    holder = service.ClientHolder(None, {"userId": "fixture", "agentId": "pi-67"}, ledger)
    client = holder._client
    failed = threading.Event()
    def injected_write(file, value):
        if file.parent == paths.operations_dir and value.get("state") == failed_state and not failed.is_set():
            failed.set()
            raise OSError(f"injected {failed_state} ledger failure")
        return original_write(file, value)
    service.write_json_atomic = injected_write
    error_state = None
    try:
        holder.capture([{"role": "user", "content": "fixture"}], "session", request_id, timeout=2.0)
    except BaseException:
        receipt = holder.operation_receipt(service.stable_operation_id("capture", request_id))
        error_state = receipt.get("state") if receipt else None
    finally:
        service.write_json_atomic = original_write
        holder.close()
    operation_id = service.stable_operation_id("capture", request_id)
    persisted = service.OperationLedger(paths, "instance-two").get(operation_id)
    return {
        "sdkCalls": client.calls,
        "currentState": error_state,
        "persistedState": persisted.get("state"),
        "retryable": persisted.get("retryable"),
    }

running = run_case(root / "running", "RUNNING", "1" * 64)
terminal = run_case(root / "terminal", "SUCCEEDED", "2" * 64)
print(json.dumps({
    "runningWriteSdkCalls": running["sdkCalls"],
    "runningWriteState": running["persistedState"],
    "runningWriteRetryable": running["retryable"],
    "terminalWriteSdkCalls": terminal["sdkCalls"],
    "terminalWriteCurrentState": terminal["currentState"],
    "terminalWriteRestartState": terminal["persistedState"],
    "terminalWriteRetryable": terminal["retryable"],
}))
`;
}
