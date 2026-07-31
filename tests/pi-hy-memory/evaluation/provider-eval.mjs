import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HyMemoryServiceClient } from "../../../extensions/pi-hy-memory/client.ts";
import { readConfig, resolveHyMemoryPaths } from "../../../extensions/pi-hy-memory/config.ts";
import { evaluateGoldenFixture } from "./evaluator.mjs";

const ERROR_SCHEMA = "pi67.hy-memory-provider-evaluation-error/v1";
const EVAL_MARKER = "PI67-EVAL-ID";
const EVAL_HOME_SCHEMA = "pi67.hy-memory-provider-evaluation-home/v1";
const EVAL_HOME_MARKER = ".pi67-hy-memory-provider-evaluation.json";

export class ProviderEvaluationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderEvaluationError";
    this.code = code;
  }
}

export function validateProviderEvaluationEnvironment(env = process.env, options = {}) {
  const { home } = resolveEvaluationHome(env, { ...options, requireNetwork: true });
  const expectedFixtureSha256 = options.expectedFixtureSha256 || sha256Text(JSON.stringify(readGoldenFixture()));
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(home, EVAL_HOME_MARKER), "utf8"));
  } catch {
    throw new ProviderEvaluationError("evaluation-home-not-prepared");
  }
  if (
    !marker || marker.schema !== EVAL_HOME_SCHEMA || marker.syntheticOnly !== true ||
    marker.fixtureSha256 !== expectedFixtureSha256 || !Number.isFinite(Date.parse(marker.preparedAt))
  ) {
    throw new ProviderEvaluationError("evaluation-home-marker-invalid");
  }
  return { home, marker };
}

export function prepareProviderEvaluationHome(env = process.env, options = {}) {
  const { home } = resolveEvaluationHome(env, { ...options, requireNetwork: false });
  if (fs.readdirSync(home).length !== 0) throw new ProviderEvaluationError("evaluation-home-not-empty");
  const fixtureSha256 = sha256Text(JSON.stringify(readGoldenFixture()));
  const marker = {
    schema: EVAL_HOME_SCHEMA,
    syntheticOnly: true,
    fixtureSha256,
    preparedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(home, EVAL_HOME_MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    throw new ProviderEvaluationError("evaluation-home-marker-write-failed");
  }
  return { schema: EVAL_HOME_SCHEMA, prepared: true, syntheticOnly: true, fixtureSha256 };
}

function resolveEvaluationHome(env, options) {
  if (options.requireNetwork && env.PI67_HY_MEMORY_EVAL_ALLOW_NETWORK !== "1") {
    throw new ProviderEvaluationError("network-opt-in-required");
  }
  if (env.PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY !== "1") {
    throw new ProviderEvaluationError("synthetic-corpus-confirmation-required");
  }
  const requestedHome = String(env.PI67_HY_MEMORY_EVAL_HOME || "").trim();
  if (!requestedHome || !path.isAbsolute(requestedHome)) {
    throw new ProviderEvaluationError("explicit-absolute-evaluation-home-required");
  }
  let home;
  try {
    home = fs.realpathSync.native(requestedHome);
    if (!fs.statSync(home).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ProviderEvaluationError("evaluation-home-unavailable");
  }
  const liveHome = canonicalPath(options.liveHome || path.join(os.homedir(), ".hy-memory", "pi67"));
  if (pathsOverlap(home, liveHome)) throw new ProviderEvaluationError("live-home-forbidden");
  return { home };
}

export async function runProviderEvaluation(options = {}) {
  const canonicalFixture = readGoldenFixture();
  const fixture = options.fixture || canonicalFixture;
  const fixtureSha256 = sha256Text(JSON.stringify(canonicalFixture));
  const { home } = validateProviderEvaluationEnvironment(options.env || process.env, {
    expectedFixtureSha256: fixtureSha256,
  });
  if (sha256Text(JSON.stringify(fixture)) !== sha256Text(JSON.stringify(canonicalFixture))) {
    throw new ProviderEvaluationError("noncanonical-evaluation-fixture");
  }
  const paths = resolveHyMemoryPaths(home);
  const config = readConfig(paths);
  if (!config) throw new ProviderEvaluationError("evaluation-home-not-initialized");
  const client = options.client || new HyMemoryServiceClient(config, paths);
  const searchClient = options.searchClient || ((topK) => new HyMemoryServiceClient({
    ...config,
    recall: { ...config.recall, topK },
  }, paths));
  const adapter = new IsolatedProviderMemoryAdapter({ client, searchClient });
  return await evaluateGoldenFixture(fixture, { adapter });
}

export class IsolatedProviderMemoryAdapter {
  constructor({ client, searchClient }) {
    this.client = client;
    this.searchClient = searchClient;
    this.mode = "isolated-provider";
    this.semanticQualityClaim = true;
    this.corpusScope = "isolated-synthetic";
    this.providerOperationRequests = 0;
    this.externalProviderRequests = null;
    this.serviceRequests = 0;
    this.estimatedCostUsd = null;
  }

  async prepare(fixture) {
    await this.#request("service-unavailable", () => this.client.info(), false);
    const listed = await this.#request("service-list-failed", () => this.client.list(1, 0), false);
    if (listedMemoryCount(listed) !== 0) throw new ProviderEvaluationError("evaluation-home-not-empty");

    const fixtureHash = sha256Text(JSON.stringify(fixture));
    const sessionId = `pi67-provider-eval-${fixtureHash.slice(0, 16)}`;
    for (const item of fixture.memoryItems) {
      if (item.status !== "active" || item.recallEligible === false) continue;
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item.id)) {
        throw new ProviderEvaluationError("unsupported-evaluation-memory-id");
      }
      const marker = `[${EVAL_MARKER}:${item.id}]`;
      const messages = [
        { role: "user", content: `Remember this synthetic evaluation fact exactly: ${marker} ${item.content}` },
        { role: "assistant", content: `Recorded synthetic evaluation fact ${marker}: ${item.content}` },
      ];
      const requestId = sha256Text(`${fixtureHash}\0${item.id}`);
      await this.#request("provider-capture-failed", () => this.client.capture(messages, sessionId, requestId), true);
    }
  }

  async search(query, options = {}) {
    const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5;
    const client = this.searchClient(topK);
    const response = await this.#request("provider-search-failed", () => client.search(query), true);
    return evaluationIds(response).slice(0, topK);
  }

  async #request(errorCode, action, providerRequest) {
    this.serviceRequests += 1;
    if (providerRequest) this.providerOperationRequests += 1;
    try {
      return await action();
    } catch {
      throw new ProviderEvaluationError(errorCode);
    }
  }
}

function readGoldenFixture() {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "golden-cases.json"), "utf8"));
}

function listedMemoryCount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderEvaluationError("service-list-response-invalid");
  }
  const root = value;
  if (Number.isInteger(root.total) && root.total >= 0) return root.total;
  if (root.vdb && typeof root.vdb === "object" && !Array.isArray(root.vdb)) {
    if (Number.isInteger(root.vdb.total) && root.vdb.total >= 0) return root.vdb.total;
  }
  throw new ProviderEvaluationError("service-list-response-invalid");
}

function evaluationIds(value) {
  const ids = [];
  const seen = new Set();
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      const pattern = /\[PI67-EVAL-ID:([a-z0-9][a-z0-9._-]{0,127})\]/g;
      for (const match of current.matchAll(pattern)) {
        if (!seen.has(match[1])) {
          seen.add(match[1]);
          ids.push(match[1]);
        }
      }
    } else if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
    } else if (current && typeof current === "object") {
      const values = Object.values(current);
      for (let index = values.length - 1; index >= 0; index -= 1) pending.push(values[index]);
    }
  }
  return ids;
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--prepare-home") || args.length > 1) {
      throw new ProviderEvaluationError("invalid-command");
    }
    const result = args[0] === "--prepare-home"
      ? prepareProviderEvaluationHome()
      : await runProviderEvaluation();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (Object.hasOwn(result, "passed") && !result.passed) process.exitCode = 1;
  } catch (error) {
    const errorKind = error instanceof ProviderEvaluationError ? error.code : "evaluation-failed";
    process.stderr.write(`${JSON.stringify({ schema: ERROR_SCHEMA, passed: false, errorKind })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
