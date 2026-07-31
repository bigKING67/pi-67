import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DeterministicMemoryAdapter, evaluateGoldenFixture } from "./evaluator.mjs";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "golden-cases.json"), "utf8"));

test("deterministic Hy-Memory golden evaluation covers recall, stale facts, exclusion, and capture policy", async () => {
  const result = await evaluateGoldenFixture(fixture);
  assert.equal(result.schema, "pi67.hy-memory-evaluation-result/v1");
  assert.equal(result.mode, "deterministic-fake");
  assert.equal(result.semanticQualityClaim, false);
  assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.totals, { cases: 8, passed: 8, failed: 0 });
  assert.equal(result.recall.mustRecallHitRate, 1);
  assert.equal(result.recall.mustNotRecallPassRate, 1);
  assert.equal(result.resources.adapterRequests, 4);
  assert.equal(result.resources.serviceRequests, 0);
  assert.equal(result.resources.providerOperationRequests, 0);
  assert.equal(result.resources.externalProviderRequests, 0);
  assert.equal(result.resources.estimatedCostUsd, 0);
});

test("golden evaluation fails when an adapter returns a forbidden memory", async () => {
  const secretCase = {
    ...fixture,
    recallCases: fixture.recallCases.filter((item) => item.id === "must-not-recall-secret"),
    captureCases: [],
  };
  const adapter = new DeterministicMemoryAdapter(fixture.memoryItems);
  adapter.search = async () => ["synthetic-secret"];
  const result = await evaluateGoldenFixture(secretCase, { adapter });
  assert.equal(result.passed, false);
  assert.equal(result.totals.failed, 1);
  assert.deepEqual(result.recall.cases[0].violations, ["forbidden:synthetic-secret"]);
});

test("golden evaluation rejects unknown expectation IDs at the fixture boundary", async () => {
  const invalid = {
    ...fixture,
    recallCases: [{ ...fixture.recallCases[0], mustRecall: ["missing-memory-id"] }],
  };
  await assert.rejects(evaluateGoldenFixture(invalid), /references unknown memory/);
});

test("golden evaluation fails closed on unknown adapter result IDs", async () => {
  const singleCase = {
    ...fixture,
    recallCases: fixture.recallCases.slice(0, 1),
    captureCases: [],
  };
  const adapter = new DeterministicMemoryAdapter(fixture.memoryItems);
  adapter.search = async () => ["unknown-result-id"];
  const result = await evaluateGoldenFixture(singleCase, { adapter });
  assert.equal(result.passed, false);
  assert.ok(result.recall.cases[0].violations.includes("invalid-response"));
});
