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
        MEMORY_DATA_DIR: path.join(stateRoot, "data"),
      },
    });
    const service = await waitForJson(path.join(stateRoot, "runtime", "service.json"), 10000, child);
    const base = `http://127.0.0.1:${service.port}`;

    const unauthorized = await fetch(`${base}/v1/info`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: `Bearer ${token}` };
    const info = await fetchJson(`${base}/v1/info`, { headers });
    assert.equal(info.schema, "pi67-hy-memory-service/v1");
    assert.equal(info.instanceId, service.instanceId);
    assert.equal(info.vectorDimensions, 1024);

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
    assert.equal(await waitForExit(child, 10000), 0);
    assert.equal(fs.existsSync(path.join(stateRoot, "runtime", "service.json")), false);
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
    assert.ok(value.dueInSeconds >= 4 && value.dueInSeconds <= 6.5, value.dueInSeconds);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function findPython() {
  for (const candidate of [
    { command: "python3", prefix: [] },
    { command: "python", prefix: [] },
    { command: "py", prefix: ["-3.11"] },
  ]) {
    const result = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && !result.error) return candidate;
  }
  return null;
}

async function waitForJson(file, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (child.exitCode !== null) {
      throw new Error(`service exited early with ${child.exitCode}: ${await streamText(child.stderr)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("service metadata timeout");
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

async function streamText(stream) {
  let value = "";
  for await (const chunk of stream) value += String(chunk);
  return value;
}

function fakeSdk() {
  return `import asyncio

__version__ = "1.2.20"

class _Box:
    pass

class MemoryConfig:
    @classmethod
    def from_dict(cls, value):
        result = _Box()
        result.vector_store = _Box()
        result.vector_store.embedding_dims = value["vector_store"]["embedding_dims"]
        return result

class _Loop:
    def run(self, coroutine):
        return asyncio.run(coroutine)

class _Embed:
    async def embed(self, _value):
        return [0.0] * 1024

class HyMemoryClient:
    def __init__(self, config=None, mode="pro"):
        self.config = config
        self.mode = mode
        self._loop_thread = _Loop()
        self._embed_service = _Embed()

    def add(self, messages, **kwargs):
        return {"success": True, "memory_id": "fixture-memory", "request_id": kwargs.get("request_id")}

    def search(self, query, **kwargs):
        if query == "private-http-error-fixture":
            raise RuntimeError(f"provider echoed {query}")
        return {"memories": {"normal": [{"content": "fixture memory", "score": 0.9}]}}

    def list_memories(self, **kwargs):
        return {"vdb": {"memories": [], "total": 0, "limit": kwargs.get("limit"), "offset": kwargs.get("offset")}}

    def get(self, memory_id):
        return {"memory_id": memory_id, "content": "fixture memory"}

    def delete(self, memory_id):
        return {"success": True, "deleted_count": 1, "memory_id": memory_id}

    def digest(self, **kwargs):
        return {"success": True, "tasks_processed": 1}

    def close(self):
        return None
`;
}

function outboxRetryProbe() {
  return String.raw`import datetime as dt
import importlib.util
import json
import sys
import time
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_service_test", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

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
}))
`;
}
