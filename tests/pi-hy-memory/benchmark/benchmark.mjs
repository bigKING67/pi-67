#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  defaultMemoryConfig,
  HY_MEMORY_SDK_VERSION,
  HY_MEMORY_WHEEL_SHA256,
  inventoryMemoryRuntimes,
  memoryPaths,
  stageMemoryRuntime,
} from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const serviceScript = path.join(repoRoot, "extensions", "pi-hy-memory", "service.py");
const outputIndex = process.argv.indexOf("--output");
const outputFile = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || "") : "";
const includePythonGeneration = process.argv.includes("--python-generation");
const python = findPython311();
if (!python) throw new Error("Python 3.11 is required for the Hy-Memory benchmark");

const startedAt = new Date().toISOString();
const service = await benchmarkService();
const storage = benchmarkLedgerAndOutbox();
const inventory = benchmarkRuntimeInventory();
const pythonGeneration = includePythonGeneration ? await benchmarkPythonGeneration() : null;
const report = {
  schema: "pi67.hy-memory-benchmark.v1",
  evidence: "MEASURED",
  measuredAt: startedAt,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    python: python.version,
    cpu: os.cpus()[0]?.model || "unknown",
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  measurements: { service, storage, runtimeInventory: inventory, pythonGeneration },
  algorithmicRisks: [
    "OperationLedger.prepare prunes terminal records synchronously and its scan cost grows with retained records and referenced outbox files.",
    "Runtime inventory recursively stats every managed generation, so latency grows with generation size and file count.",
    "Outbox and operation counts scan JSON directories; configured hard limits bound growth but do not make the scan constant-time.",
  ],
  needsMeasurement: [
    "Native Windows x64 and Linux x64 cold-start, RSS and filesystem behavior are not proven by this host.",
    "Real provider latency and SDK database growth are excluded because the benchmark uses an isolated fake SDK.",
    "Long-horizon pipeline JSONL/history disk growth remains under F-DATA-001 and requires upstream SDK controls.",
  ],
};
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, encoded);
}
process.stdout.write(encoded);

async function benchmarkService() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-benchmark-service-"));
  const root = path.join(tmp, "state");
  const fakeRoot = path.join(tmp, "fake-sdk");
  const token = "benchmark-service-token";
  let child;
  try {
    fs.mkdirSync(path.join(fakeRoot, "hy_memory"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "hy_memory", "__init__.py"), fakeSdk());
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(defaultMemoryConfig("benchmark-user"))}\n`);
    const spawnAt = performance.now();
    child = spawn(python.command, [...python.prefix, serviceScript, "--root", root, "--port", "0"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        PYTHONPATH: fakeRoot,
        PI67_HY_MEMORY_SERVICE_TOKEN: token,
        PI67_HY_MEMORY_LLM_API_KEY: "benchmark-only",
        PI67_HY_MEMORY_EMBEDDING_API_KEY: "benchmark-only",
        MEMORY_DATA_DIR: path.join(root, "data"),
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const record = await waitForJson(path.join(root, "runtime", "service.json"), 30_000, child, () => stderr);
    const base = `http://127.0.0.1:${record.port}`;
    const headers = { authorization: `Bearer ${token}` };
    await fetchOk(`${base}/v1/info`, { headers });
    const coldStartToAuthenticatedInfoMs = round(performance.now() - spawnAt);
    const idleRssBytes = processRssBytes(child.pid);

    const searchLatencies = [];
    for (let index = 0; index < 25; index += 1) {
      searchLatencies.push(await requestLatency(`${base}/v1/search`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query: `benchmark-${index}` }),
      }));
    }
    const captureLatencies = [];
    for (let index = 0; index < 20; index += 1) {
      captureLatencies.push(await requestLatency(`${base}/v1/capture`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.createHash("sha256").update(`benchmark-${index}`).digest("hex"),
          sessionId: "benchmark",
          messages: [{ role: "user", content: "benchmark" }],
        }),
      }));
    }

    const concurrentAt = performance.now();
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => fetchOk(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "5000" },
      body: JSON.stringify({ query: `queue-${index}` }),
    })));
    const concurrentMs = performance.now() - concurrentAt;
    const overload = await Promise.all(Array.from({ length: 20 }, (_, index) => fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-pi67-timeout-ms": "5000" },
      body: JSON.stringify({ query: `overload-${index}` }),
    })));
    await fetchOk(`${base}/v1/shutdown`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    await waitForExit(child, 10_000);

    return {
      coldStartToAuthenticatedInfoMs,
      idleRssBytes,
      searchLatencyMs: percentileSummary(searchLatencies),
      captureLatencyMs: percentileSummary(captureLatencies),
      queue8: {
        elapsedMs: round(concurrentMs),
        operationsPerSecond: round(8_000 / concurrentMs),
        maxSdkConcurrency: Math.max(...concurrent.map((value) => value.maxActive)),
      },
      overload20: {
        accepted: overload.filter((response) => response.status === 200).length,
        rejected: overload.filter((response) => response.status === 503).length,
      },
      initialLogBytes: fileSize(path.join(root, "logs", "service.log")),
    };
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function benchmarkLedgerAndOutbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-benchmark-storage-"));
  try {
    const result = spawnSync(python.command, [...python.prefix, "-c", storageProbe(), serviceScript, tmp], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function benchmarkRuntimeInventory() {
  const results = [];
  for (const generations of [1, 5, 20]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-benchmark-inventory-"));
    try {
      const paths = memoryPaths(home);
      fs.mkdirSync(paths.runtimeDir, { recursive: true });
      let current;
      for (let index = 0; index < generations; index += 1) {
        const content = `benchmark-wrapper-${index}`;
        const wrapperSha256 = crypto.createHash("sha256").update(content).digest("hex");
        const generation = path.join(paths.runtimeDir, `hy-memory-${HY_MEMORY_SDK_VERSION}-pi67-${wrapperSha256.slice(0, 12)}`);
        const pythonPath = process.platform === "win32"
          ? path.join(generation, "venv", "Scripts", "python.exe")
          : path.join(generation, "venv", "bin", "python");
        fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
        fs.writeFileSync(path.join(generation, "service.py"), content);
        fs.writeFileSync(pythonPath, "benchmark-python");
        for (let file = 0; file < 25; file += 1) fs.writeFileSync(path.join(generation, `fixture-${file}.bin`), Buffer.alloc(4096));
        current = { generation, pythonPath, wrapperSha256 };
      }
      fs.writeFileSync(paths.runtimeFile, `${JSON.stringify({
        schema: "pi67-hy-memory-runtime/v1",
        sdkVersion: HY_MEMORY_SDK_VERSION,
        python: current.pythonPath,
        serviceScript: path.join(current.generation, "service.py"),
        wrapperSha256: current.wrapperSha256,
        wheelSha256: HY_MEMORY_WHEEL_SHA256,
        installedAt: "2026-07-31T00:00:00Z",
      })}\n`);
      const samples = [];
      for (let run = 0; run < 10; run += 1) {
        const start = performance.now();
        inventoryMemoryRuntimes({ home });
        samples.push(performance.now() - start);
      }
      results.push({ generations, filesPerGeneration: 27, latencyMs: percentileSummary(samples) });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  return results;
}

async function benchmarkPythonGeneration() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-hy-memory-benchmark-python-generation-"));
  try {
    const started = performance.now();
    const staged = await stageMemoryRuntime({ repoRoot }, { paths: memoryPaths(home) });
    const elapsedMs = performance.now() - started;
    const usage = directoryUsage(staged.root);
    const manifest = JSON.parse(fs.readFileSync(staged.runtime.pythonRuntimeManifest, "utf8"));
    return {
      target: staged.runtime.dependencyLockTarget,
      installMs: round(elapsedMs),
      sizeBytes: usage.bytes,
      allocatedBytes: usage.allocatedBytes,
      files: usage.files,
      distributions: manifest.distributionCount,
      reused: staged.reused,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function storageProbe() {
  return String.raw`import importlib.util
import json
import sys
import time
from pathlib import Path

service_file = Path(sys.argv[1])
root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pi67_hy_memory_benchmark", service_file)
service = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = service
spec.loader.exec_module(service)

def directory_bytes(directory):
    return sum(file.stat().st_size for file in directory.glob("*.json") if file.is_file())

ledger_results = []
for count in (100, 1000):
    case = service.StatePaths(root / f"ledger-{count}")
    case.ensure()
    ledger = service.OperationLedger(case, "writer")
    write_started = time.perf_counter()
    ids = []
    for index in range(count):
        operation_id = service.stable_operation_id("capture", f"terminal-{index}")
        ids.append(operation_id)
        ledger.prepare(operation_id, "capture")
        ledger.transition(operation_id, "RUNNING", retryable=False, startedAt=service.utc_now())
        ledger.transition(operation_id, "SUCCEEDED", retryable=False, result={"success": True}, resultAvailable=True)
    write_ms = (time.perf_counter() - write_started) * 1000
    startup_started = time.perf_counter()
    reloaded = service.OperationLedger(case, "reader")
    startup_ms = (time.perf_counter() - startup_started) * 1000
    query_started = time.perf_counter()
    for operation_id in ids:
        reloaded.get(operation_id)
    query_ms = (time.perf_counter() - query_started) * 1000
    ledger_results.append({
        "records": count,
        "writeMs": round(write_ms, 3),
        "startupMs": round(startup_ms, 3),
        "queryAllMs": round(query_ms, 3),
        "diskBytes": directory_bytes(case.operations_dir),
    })

unknown_case = service.StatePaths(root / "unknown")
unknown_case.ensure()
unknown_ledger = service.OperationLedger(unknown_case, "writer")
for index in range(100):
    operation_id = service.stable_operation_id("capture", f"unknown-{index}")
    unknown_ledger.prepare(operation_id, "capture")
    unknown_ledger.transition(operation_id, "RUNNING", retryable=False, startedAt=service.utc_now())
    unknown_ledger.transition(operation_id, "UNKNOWN", retryable=False, error={"code": "benchmark"})

class Holder:
    def capture(self, *_args):
        return {"success": True}
    def operation_receipt(self, _operation_id):
        return None

outbox_results = []
for count in (1, 5, 20):
    case = service.StatePaths(root / f"outbox-{count}")
    case.ensure()
    for index in range(count):
        request_id = service.stable_operation_id("capture", f"outbox-{count}-{index}")
        service.write_json_atomic(case.pending_dir / f"{request_id}.json", {
            "schema": service.OUTBOX_SCHEMA,
            "requestId": request_id,
            "userId": "benchmark",
            "agentId": "pi-67",
            "sessionId": "benchmark",
            "messages": [{"role": "user", "content": "benchmark"}],
            "attempts": 0,
            "createdAt": service.utc_now(),
            "updatedAt": service.utc_now(),
        })
    before = directory_bytes(case.pending_dir)
    processor = service.OutboxProcessor(case, {
        "userId": "benchmark",
        "agentId": "pi-67",
        "capture": {"maxAttempts": 5, "batchTurns": 5, "maxDelayMs": 60000},
    }, Holder())
    started = time.perf_counter()
    processor._drain(force=True)
    elapsed = (time.perf_counter() - started) * 1000
    outbox_results.append({"jobs": count, "drainMs": round(elapsed, 3), "pendingDiskBytes": before})

print(json.dumps({
    "ledger": ledger_results,
    "unknown100DiskBytes": directory_bytes(unknown_case.operations_dir),
    "outbox": outbox_results,
}))
`;
}

function fakeSdk() {
  return `import asyncio
import os
import time

__version__ = "1.2.20"

class Box:
    pass

class MemoryConfig:
    @classmethod
    def from_dict(cls, value):
        result = Box()
        result.vector_store = Box()
        result.vector_store.embedding_dims = value["vector_store"]["embedding_dims"]
        result.coding = Box()
        result.coding.enable = False
        result.history = Box()
        result.history.enable = False
        result.history_enabled = False
        return result

class Loop:
    def run(self, coroutine):
        return asyncio.run(coroutine)

class Embed:
    async def embed(self, _value):
        return [0.0] * 1024

class HyMemoryClient:
    active = 0
    max_active = 0
    def __init__(self, config=None, mode="pro"):
        self.config = config
        self.mode = mode
        self._loop_thread = Loop()
        self._embed_service = Embed()
    def search(self, query, **_kwargs):
        type(self).active += 1
        type(self).max_active = max(type(self).max_active, type(self).active)
        try:
            if query.startswith("queue-") or query.startswith("overload-"):
                time.sleep(0.01)
            return {"memories": {"normal": []}, "maxActive": type(self).max_active}
        finally:
            type(self).active -= 1
    def add(self, _messages, **kwargs):
        return {"success": True, "request_id": kwargs.get("request_id")}
    def close(self):
        return None
`;
}

function findPython311() {
  const uv = spawnSync("uv", ["python", "find", "3.11"], { encoding: "utf8", windowsHide: true });
  const uvPython = uv.status === 0 ? String(uv.stdout).trim() : "";
  for (const candidate of [
    ...(uvPython ? [{ command: uvPython, prefix: [] }] : []),
    { command: "python3.11", prefix: [] },
    { command: "python3", prefix: [] },
    { command: "py", prefix: ["-3.11"] },
  ]) {
    const result = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8", windowsHide: true });
    const version = String(result.stdout || result.stderr).trim();
    if (result.status === 0 && /Python 3\.11\./.test(version)) return { ...candidate, version: version.replace(/^Python\s+/, "") };
  }
  return null;
}

async function waitForJson(file, timeoutMs, child, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (child.exitCode !== null) throw new Error(`service exited early: ${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`service metadata timeout: ${diagnostics()}`);
}

async function fetchOk(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text);
}

async function requestLatency(url, options) {
  const started = performance.now();
  await fetchOk(url, options);
  return performance.now() - started;
}

function percentileSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    min: round(sorted[0]),
    p50: round(sorted[Math.floor((sorted.length - 1) * 0.50)]),
    p95: round(sorted[Math.floor((sorted.length - 1) * 0.95)]),
    max: round(sorted.at(-1)),
  };
}

function processRssBytes(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kib = Number.parseInt(String(result.stdout).trim(), 10);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function directoryUsage(root) {
  let bytes = 0;
  let allocatedBytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        bytes += stat.size;
        if (Number.isFinite(stat.blocks)) allocatedBytes += stat.blocks * 512;
        files += 1;
      }
    }
  }
  return { bytes, allocatedBytes: allocatedBytes || null, files };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
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
