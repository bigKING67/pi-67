import { performance } from "node:perf_hooks";
import { extractCaptureMessages } from "../../../extensions/pi-hy-memory/security.ts";

const FIXTURE_SCHEMA = "pi67.hy-memory-golden-evaluation/v1";

export class DeterministicMemoryAdapter {
  constructor(memoryItems) {
    this.memoryItems = memoryItems;
    this.externalProviderRequests = 0;
    this.estimatedCostUsd = 0;
  }

  async search(query, options = {}) {
    const queryTokens = tokens(query);
    return this.memoryItems
      .filter((item) => item.status === "active" && item.recallEligible !== false)
      .map((item) => ({ id: item.id, score: overlapScore(queryTokens, tokens(item.content)) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, options.topK || 5)
      .map((item) => item.id);
  }
}

export async function evaluateGoldenFixture(fixture, options = {}) {
  validateFixture(fixture);
  const adapter = options.adapter || new DeterministicMemoryAdapter(fixture.memoryItems);
  if (typeof adapter.prepare === "function") await adapter.prepare(fixture);
  const now = options.now || (() => performance.now());
  const knownMemoryIds = new Set(fixture.memoryItems.map((item) => item.id));
  const recallResults = [];
  const latencies = [];
  let adapterRequests = 0;
  let mustRecallTotal = 0;
  let mustRecallHits = 0;
  let mustNotRecallTotal = 0;
  let mustNotRecallPasses = 0;

  for (const evaluationCase of fixture.recallCases) {
    const startedAt = now();
    const rawRecall = await adapter.search(evaluationCase.query, { topK: evaluationCase.topK });
    const latencyMs = Math.max(0, now() - startedAt);
    latencies.push(latencyMs);
    adapterRequests += 1;
    const responseValid = Array.isArray(rawRecall)
      && new Set(rawRecall).size === rawRecall.length
      && rawRecall.every((id) => typeof id === "string" && knownMemoryIds.has(id));
    const recalledIds = responseValid ? rawRecall : [];
    const missing = evaluationCase.mustRecall.filter((id) => !recalledIds.includes(id));
    const forbidden = evaluationCase.mustNotRecall.filter((id) => recalledIds.includes(id));
    mustRecallTotal += evaluationCase.mustRecall.length;
    mustRecallHits += evaluationCase.mustRecall.length - missing.length;
    mustNotRecallTotal += evaluationCase.mustNotRecall.length;
    mustNotRecallPasses += evaluationCase.mustNotRecall.length - forbidden.length;
    const violations = [
      ...(!responseValid ? ["invalid-response"] : []),
      ...missing.map((id) => `missing:${id}`),
      ...forbidden.map((id) => `forbidden:${id}`),
      ...(latencyMs > evaluationCase.maxLatencyMs ? [`latency:${latencyMs.toFixed(3)}ms`] : []),
    ];
    recallResults.push({
      caseId: evaluationCase.id,
      passed: violations.length === 0,
      recalledIds,
      latencyMs,
      violations,
    });
  }

  const captureResults = fixture.captureCases.map((evaluationCase) => {
    const captured = extractCaptureMessages(evaluationCase.messages);
    const accepted = captured.length >= 2;
    const contents = captured.map((item) => item.content);
    const violations = [];
    if (accepted !== evaluationCase.expectedAccepted) violations.push("acceptance-mismatch");
    if (!sameStringArray(contents, evaluationCase.expectedCapturedContents)) violations.push("captured-content-mismatch");
    const serialized = contents.join("\n");
    for (const forbidden of evaluationCase.forbiddenSubstrings) {
      if (serialized.includes(forbidden)) violations.push("forbidden-content");
    }
    return { caseId: evaluationCase.id, passed: violations.length === 0, accepted, violations };
  });

  const allResults = [...recallResults, ...captureResults];
  const estimatedCostUsd = adapter.estimatedCostUsd === null
    ? null
    : Number(adapter.estimatedCostUsd || 0);
  const externalProviderRequests = adapter.externalProviderRequests === null
    ? null
    : Number(adapter.externalProviderRequests || 0);
  return {
    schema: "pi67.hy-memory-evaluation-result/v1",
    mode: String(options.mode || adapter.mode || "deterministic-fake"),
    semanticQualityClaim: Boolean(options.semanticQualityClaim ?? adapter.semanticQualityClaim ?? false),
    corpusScope: String(options.corpusScope || adapter.corpusScope || "fixture-only"),
    passed: allResults.every((item) => item.passed),
    totals: {
      cases: allResults.length,
      passed: allResults.filter((item) => item.passed).length,
      failed: allResults.filter((item) => !item.passed).length,
    },
    recall: {
      cases: recallResults,
      mustRecallHitRate: ratio(mustRecallHits, mustRecallTotal),
      mustNotRecallPassRate: ratio(mustNotRecallPasses, mustNotRecallTotal),
    },
    capture: { cases: captureResults },
    resources: {
      adapterRequests,
      serviceRequests: Number(adapter.serviceRequests || 0),
      providerOperationRequests: Number(adapter.providerOperationRequests || 0),
      externalProviderRequests,
      estimatedCostUsd,
      totalLatencyMs: latencies.reduce((total, value) => total + value, 0),
      p95LatencyMs: percentile(latencies, 0.95),
    },
  };
}

function validateFixture(fixture) {
  if (!fixture || fixture.schema !== FIXTURE_SCHEMA) throw new Error("unsupported Hy-Memory evaluation fixture schema");
  for (const field of ["memoryItems", "recallCases", "captureCases"]) {
    if (!Array.isArray(fixture[field])) throw new Error(`${field} must be an array`);
  }
  const memoryIds = uniqueIds(fixture.memoryItems, "memoryItems");
  uniqueIds(fixture.recallCases, "recallCases");
  uniqueIds(fixture.captureCases, "captureCases");
  for (const item of fixture.memoryItems) {
    if (typeof item.content !== "string" || !item.content.trim()) throw new Error(`${item.id}.content is required`);
    if (!["active", "superseded"].includes(item.status)) throw new Error(`${item.id}.status is invalid`);
    if (item.recallEligible !== undefined && typeof item.recallEligible !== "boolean") {
      throw new Error(`${item.id}.recallEligible is invalid`);
    }
    if (item.supersededBy !== undefined && !memoryIds.has(item.supersededBy)) {
      throw new Error(`${item.id}.supersededBy references unknown memory`);
    }
  }
  for (const evaluationCase of fixture.recallCases) {
    if (typeof evaluationCase.query !== "string" || !evaluationCase.query.trim()) throw new Error(`${evaluationCase.id} query is required`);
    for (const field of ["mustRecall", "mustNotRecall"]) {
      if (!Array.isArray(evaluationCase[field])) throw new Error(`${evaluationCase.id}.${field} must be an array`);
      for (const id of evaluationCase[field]) {
        if (!memoryIds.has(id)) throw new Error(`${evaluationCase.id}.${field} references unknown memory: ${id}`);
      }
    }
    if (!Number.isInteger(evaluationCase.topK) || evaluationCase.topK < 1) throw new Error(`${evaluationCase.id}.topK is invalid`);
    if (!Number.isFinite(evaluationCase.maxLatencyMs) || evaluationCase.maxLatencyMs <= 0) {
      throw new Error(`${evaluationCase.id}.maxLatencyMs is invalid`);
    }
  }
  for (const evaluationCase of fixture.captureCases) {
    if (!Array.isArray(evaluationCase.messages)) throw new Error(`${evaluationCase.id}.messages must be an array`);
    if (typeof evaluationCase.expectedAccepted !== "boolean") throw new Error(`${evaluationCase.id}.expectedAccepted is invalid`);
    if (!Array.isArray(evaluationCase.expectedCapturedContents) || !Array.isArray(evaluationCase.forbiddenSubstrings)) {
      throw new Error(`${evaluationCase.id} capture expectations are invalid`);
    }
  }
}

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error(`${label} contains an invalid id`);
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function tokens(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) || []);
}

function overlapScore(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches / Math.sqrt(left.size * right.size);
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile(values, value) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}
