const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_HISTORY_LIMIT = 3;
const DEFAULT_STRICT_TREND_LIMIT = 3;
const DEFAULT_DRIFT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 15000;

function defaultArtifactDir(env = process.env) {
  return env.PI67_XTALPI_SMOKE_DIR || path.join(os.homedir(), "tmp", "xtalpi-pi-tools-smoke");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function compactRequestLatency(run) {
  return {
    requestCount: run?.requestCount ?? null,
    requestLatencyMsMin: run?.requestLatencyMsMin ?? null,
    requestLatencyMsMax: run?.requestLatencyMsMax ?? null,
    requestLatencyMsAvg: run?.requestLatencyMsAvg ?? null,
    slowRequestCount: run?.slowRequestCount ?? null,
    slowRequestThresholdMs: run?.slowRequestThresholdMs ?? null,
  };
}

function compactCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => Number(count) > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countMapTotal(value) {
  return Object.values(compactCountMap(value)).reduce((total, count) => total + Number(count || 0), 0);
}

function compactArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactToolSelectionTelemetry(run) {
  const fingerprint = run?.runtimeFingerprint || {};
  return {
    toolSelectionClippedCases: run?.toolSelectionClippedCases ?? null,
    toolSelectionOmittedCountMax: run?.toolSelectionOmittedCountMax ?? null,
    toolSelectionReasonCodes: compactCountMap(run?.toolSelectionReasonCodes),
    selectedToolSelectionReasonCodes: compactCountMap(run?.selectedToolSelectionReasonCodes),
    omittedToolSelectionReasonCodes: compactCountMap(run?.omittedToolSelectionReasonCodes),
    runtimeFingerprintSha256: run?.runtimeFingerprintSha256 || null,
    runtimeSelectedToolNames: compactArray(fingerprint.selectedToolNames),
    runtimeMaxTools: compactArray(fingerprint.maxTools),
    runtimeToolSelectionClipped: compactArray(fingerprint.toolSelectionClipped),
    runtimeToolSelectionOmittedCount: compactArray(fingerprint.toolSelectionOmittedCount),
    runtimeToolSelectionValidCount: compactArray(fingerprint.toolSelectionValidCount),
    runtimeToolSelectionPromptSources: compactArray(fingerprint.toolSelectionPromptSources),
  };
}

function hasReasonCodeTelemetry(run) {
  return (
    countMapTotal(run?.toolSelectionReasonCodes) +
    countMapTotal(run?.selectedToolSelectionReasonCodes) +
    countMapTotal(run?.omittedToolSelectionReasonCodes)
  ) > 0;
}

function deriveReasonCodeTelemetry(trendData) {
  const runs = Array.isArray(trendData?.runs) ? trendData.runs : [];
  const supportedRunIds = runs.filter(hasReasonCodeTelemetry).map((run) => run.runId).filter(Boolean);
  const unsupportedRunIds = runs.filter((run) => !hasReasonCodeTelemetry(run)).map((run) => run.runId).filter(Boolean);
  let compatibility = "unsupported";
  if (runs.length === 0) {
    compatibility = "no_runs";
  } else if (unsupportedRunIds.length === 0) {
    compatibility = "supported";
  } else if (supportedRunIds.length > 0) {
    compatibility = "partial";
  }
  return {
    supported: runs.length > 0 && unsupportedRunIds.length === 0,
    compatibility,
    totalRuns: runs.length,
    supportedRunIds,
    unsupportedRunIds,
  };
}

function compactRun(run) {
  return {
    runId: run?.runId || null,
    ok: run?.ok ?? null,
    failures: run?.failures ?? null,
    cases: run?.cases ?? null,
    runKind: run?.runKind || null,
    selectedCases: Array.isArray(run?.selectedCases) ? run.selectedCases : [],
    caseSetSha256: run?.caseSet?.sha256 || null,
    provider: run?.provider || null,
    model: run?.model || null,
    recoveries: run?.recoveries ?? null,
    recoveryRate: run?.recoveryRate ?? null,
    rawToolMarkupFinalAnswers: run?.rawToolMarkupFinalAnswers ?? null,
    emptyAssistantEnds: run?.emptyAssistantEnds ?? null,
    toolEnvelopeFinalAnswers: run?.toolEnvelopeFinalAnswers ?? null,
    errors: run?.errors ?? null,
    processLifecycleFailures: run?.processLifecycleFailures ?? null,
    watchdogTimeouts: run?.watchdogTimeouts ?? null,
    timedOutAfterAgentEnd: run?.timedOutAfterAgentEnd ?? null,
    providerErrors: run?.providerErrors ?? null,
    retryableProviderErrors: run?.retryableProviderErrors ?? null,
    ...compactRequestLatency(run),
    argumentValidationWarnings: run?.argumentValidationWarnings ?? null,
    ...compactToolSelectionTelemetry(run),
    debugSummaryStatus: run?.debugSummaryStatus ?? null,
    gateFailures: Array.isArray(run?.gateFailures) ? run.gateFailures : [],
    parseError: run?.parseError || null,
  };
}

function compactHistory(data) {
  return {
    schema: data?.schema || null,
    requested: data?.requested ?? null,
    totalArtifacts: data?.totalArtifacts ?? null,
    candidateArtifacts: data?.candidateArtifacts ?? null,
    filteredOutArtifacts: data?.filteredOutArtifacts ?? null,
    filter: data?.filter || null,
    found: data?.found ?? null,
    order: data?.order || null,
    parseErrorCount: data?.parseErrorCount ?? null,
    runs: Array.isArray(data?.runs) ? data.runs.map(compactRun) : [],
  };
}

function countRunKinds(runs) {
  const counts = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    const kind = run?.runKind || "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function compactTrendGate(data) {
  const historyRuns = Array.isArray(data?.history?.runs) ? data.history.runs : [];
  const runs = historyRuns.map(compactRun);
  return {
    schema: data?.schema || null,
    requested: data?.requested ?? null,
    totalArtifacts: data?.totalArtifacts ?? null,
    candidateArtifacts: data?.candidateArtifacts ?? data?.history?.candidateArtifacts ?? null,
    filteredOutArtifacts: data?.filteredOutArtifacts ?? data?.history?.filteredOutArtifacts ?? null,
    filter: data?.filter || data?.history?.filter || null,
    found: data?.found ?? null,
    order: data?.order || null,
    ok: data?.ok ?? null,
    gateFailures: Array.isArray(data?.gateFailures) ? data.gateFailures : [],
    limits: data?.limits || null,
    recoveryTrend: data?.recoveryTrend || null,
    repeatedRecoveryCases: Array.isArray(data?.repeatedRecoveryCases) ? data.repeatedRecoveryCases : [],
    recoveryCaseRunCounts: data?.recoveryCaseRunCounts || {},
    runKindCounts: countRunKinds(historyRuns),
    runs,
    reasonCodeTelemetry: deriveReasonCodeTelemetry({ runs }),
  };
}

function compactDriftRun(run) {
  return {
    runId: run?.runId || null,
    ok: run?.ok ?? null,
    provider: run?.provider || null,
    model: run?.model || null,
    runKind: run?.runKind || null,
    cases: run?.cases ?? null,
    caseSetSha256: run?.caseSetSha256 || null,
    recoveries: run?.recoveries ?? null,
    recoveryRate: run?.recoveryRate ?? null,
    providerErrors: run?.providerErrors ?? null,
    retryableProviderErrors: run?.retryableProviderErrors ?? null,
    ...compactRequestLatency(run),
    argumentValidationWarnings: run?.argumentValidationWarnings ?? null,
    rawToolMarkupFinalAnswers: run?.rawToolMarkupFinalAnswers ?? null,
    emptyAssistantEnds: run?.emptyAssistantEnds ?? null,
    processLifecycleFailures: run?.processLifecycleFailures ?? null,
    runtimeBoundsSha256: run?.runtimeBoundsSha256 || null,
    runtimeFingerprintSha256: run?.runtimeFingerprintSha256 || null,
    providerHealthSha256: run?.providerHealthSha256 || null,
    runtimeBounds: run?.runtimeBounds || null,
    providerHealth: run?.providerHealth || null,
    parseError: run?.parseError || null,
  };
}

function compactDimensionEntries(entries, fields) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const result = {
      key: entry?.key || null,
      count: entry?.count ?? null,
      runIds: Array.isArray(entry?.runIds) ? entry.runIds : [],
    };
    for (const field of fields) {
      result[field] = entry?.[field] ?? null;
    }
    return result;
  });
}

function compactDrift(data) {
  return {
    schema: data?.schema || null,
    requested: data?.requested ?? null,
    totalArtifacts: data?.totalArtifacts ?? null,
    candidateArtifacts: data?.candidateArtifacts ?? null,
    filteredOutArtifacts: data?.filteredOutArtifacts ?? null,
    filter: data?.filter || null,
    found: data?.found ?? null,
    order: data?.order || null,
    parseErrorCount: data?.parseErrorCount ?? null,
    latestRunId: data?.latestRunId || null,
    baselineRunId: data?.baselineRunId || null,
    runKindCounts: data?.runKindCounts || {},
    drift: data?.drift || null,
    qualityTotals: data?.qualityTotals || null,
    dimensions: {
      providerModels: compactDimensionEntries(data?.dimensions?.providerModels, ["provider", "model"]),
      caseSets: compactDimensionEntries(data?.dimensions?.caseSets, ["sha256", "countCases", "canonical"]),
      runtimeFingerprints: compactDimensionEntries(data?.dimensions?.runtimeFingerprints, ["sha256"]),
      runtimeBounds: compactDimensionEntries(data?.dimensions?.runtimeBounds, ["sha256", "bounds"]),
      providerHealth: compactDimensionEntries(data?.dimensions?.providerHealth, ["sha256", "summary"]),
    },
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    runs: Array.isArray(data?.runs) ? data.runs.map(compactDriftRun) : [],
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerHealthAttempts(health) {
  return Array.isArray(health?.attempts) ? health.attempts : [];
}

function deriveProviderHealthTrend(status) {
  const runs = Array.isArray(status?.drift?.data?.runs) && status.drift.data.runs.length > 0
    ? status.drift.data.runs
    : Array.isArray(status?.history?.data?.runs)
      ? status.history.data.runs
      : [];
  const seen = new Set();
  const entries = [];

  for (const run of runs) {
    const health = run?.providerHealth || run?.providerHealthSummary || null;
    if (!health || typeof health !== "object" || Array.isArray(health)) continue;
    const key = run?.runId || `${entries.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ run, health });
  }

  if (entries.length === 0) return null;

  let okPreflights = 0;
  let failedPreflights = 0;
  let retriedPreflights = 0;
  let retryCountTotal = 0;
  let timeoutAttempts = 0;
  let retryableAttempts = 0;
  let maxElapsedMs = null;
  let elapsedMsTotal = 0;
  let elapsedMsCount = 0;

  for (const { health } of entries) {
    if (health.ok === true) okPreflights += 1;
    if (health.ok === false) failedPreflights += 1;

    const attemptCount = finiteNumber(health.attemptCount);
    const retryCount = finiteNumber(health.retryCount);
    if ((retryCount ?? 0) > 0 || (attemptCount ?? 0) > 1) retriedPreflights += 1;
    retryCountTotal += Math.max(0, retryCount ?? Math.max(0, (attemptCount ?? 1) - 1));

    const elapsedMs = finiteNumber(health.elapsedMs);
    if (elapsedMs !== null) {
      maxElapsedMs = maxElapsedMs === null ? elapsedMs : Math.max(maxElapsedMs, elapsedMs);
      elapsedMsTotal += elapsedMs;
      elapsedMsCount += 1;
    }

    const attempts = providerHealthAttempts(health);
    if (attempts.length > 0) {
      timeoutAttempts += attempts.filter((attempt) => (
        attempt?.errorCategory === "timeout" || attempt?.errorCode === "request_timeout"
      )).length;
      retryableAttempts += attempts.filter((attempt) => attempt?.retryable === true).length;
    } else {
      if (health.errorCategory === "timeout" || health.errorCode === "request_timeout") timeoutAttempts += 1;
      if (health.retryable === true) retryableAttempts += 1;
    }
  }

  const latest = entries[0];
  return {
    totalPreflights: entries.length,
    okPreflights,
    failedPreflights,
    retriedPreflights,
    retryCountTotal,
    timeoutAttempts,
    retryableAttempts,
    maxElapsedMs,
    avgElapsedMs: elapsedMsCount > 0 ? Math.round(elapsedMsTotal / elapsedMsCount) : null,
    latestRunId: latest?.run?.runId || null,
  };
}

function runDebugSummary({ repoRoot, script, artifactDir, args, timeoutMs, compact }) {
  const result = spawnSync("bash", [script, ...args, artifactDir], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const parsed = parseJson(String(result.stdout || ""));
  const entry = {
    ok: result.status === 0 && parsed.ok,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error ? result.error.message : null,
    stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr || "", "utf8"),
    parseError: parsed.ok ? null : parsed.error,
  };
  if (parsed.ok) entry.data = compact(parsed.data);
  return entry;
}

function deriveResult(status) {
  if (!status.available) return "UNAVAILABLE";
  if (!status.artifactsExist) return "NO_ARTIFACTS";
  if (!status.history?.ok) return "ATTENTION";
  if (!status.strictTrendGate?.ok || status.strictTrendGate?.data?.ok !== true) return "ATTENTION";
  if (
    status.rankingTrendGate &&
    status.rankingTrendGate.skipped !== true &&
    (!status.rankingTrendGate.ok || status.rankingTrendGate.data?.ok !== true)
  ) {
    return "ATTENTION";
  }
  if (status.drift && !status.drift.ok) return "ATTENTION";
  return "OK";
}

function collectXtalpiSmokeStatus(options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const artifactDir = options.artifactDir || defaultArtifactDir();
  const debugSummaryScript = options.debugSummaryScript || path.join(repoRoot, "scripts", "pi67-xtalpi-pi-tools-debug-summary.sh");
  const historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT);
  const strictTrendLimit = positiveInteger(options.strictTrendLimit, DEFAULT_STRICT_TREND_LIMIT);
  const driftLimit = positiveInteger(options.driftLimit, DEFAULT_DRIFT_LIMIT);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const status = {
    schemaVersion: 1,
    schemaId: "pi67-xtalpi-smoke-status/v1",
    generatedAt: new Date().toISOString(),
    artifactDir,
    debugSummaryScript,
    historyLimit,
    strictTrendLimit,
    driftLimit,
    timeoutMs,
    available: true,
    artifactsExist: fs.existsSync(artifactDir) && fs.statSync(artifactDir).isDirectory(),
    warnings: [],
  };

  if (!fs.existsSync(debugSummaryScript)) {
    status.available = false;
    status.warnings.push(`debug summary script missing: ${debugSummaryScript}`);
    status.result = deriveResult(status);
    return status;
  }
  if (!isExecutable(debugSummaryScript)) {
    status.available = false;
    status.warnings.push(`debug summary script is not executable: ${debugSummaryScript}`);
    status.result = deriveResult(status);
    return status;
  }
  if (!status.artifactsExist) {
    status.warnings.push(`smoke artifact directory missing: ${artifactDir}`);
    status.result = deriveResult(status);
    return status;
  }

  status.history = runDebugSummary({
    repoRoot,
    script: debugSummaryScript,
    artifactDir,
    args: ["--history", String(historyLimit), "--json"],
    timeoutMs,
    compact: compactHistory,
  });
  status.strictTrendGate = runDebugSummary({
    repoRoot,
    script: debugSummaryScript,
    artifactDir,
    args: ["--trend-gate", String(strictTrendLimit), "--profile", "full-suite-strict", "--json"],
    timeoutMs,
    compact: compactTrendGate,
  });
  status.reasonCodeTelemetry = deriveReasonCodeTelemetry(status.strictTrendGate?.data);
  if (status.reasonCodeTelemetry.supported) {
    status.rankingTrendGate = runDebugSummary({
      repoRoot,
      script: debugSummaryScript,
      artifactDir,
      args: ["--trend-gate", String(strictTrendLimit), "--profile", "full-suite-ranking-strict", "--json"],
      timeoutMs,
      compact: compactTrendGate,
    });
  } else {
    status.rankingTrendGate = {
      ok: true,
      skipped: true,
      reason: "reason-code telemetry missing from one or more selected full-suite smoke artifacts",
      compatibility: status.reasonCodeTelemetry,
    };
  }
  status.drift = runDebugSummary({
    repoRoot,
    script: debugSummaryScript,
    artifactDir,
    args: ["--drift", String(driftLimit), "--run-kind", "full-suite", "--json"],
    timeoutMs,
    compact: compactDrift,
  });

  if (status.history && !status.history.ok) {
    status.warnings.push("xtalpi smoke history summary failed");
  }
  if (status.strictTrendGate && status.strictTrendGate.data?.ok === false) {
    const failures = status.strictTrendGate.data.gateFailures || [];
    status.warnings.push(`xtalpi full-suite-strict trend gate failed: ${failures.join("; ")}`);
  } else if (status.strictTrendGate && !status.strictTrendGate.ok) {
    status.warnings.push("xtalpi full-suite-strict trend gate failed to run");
  }
  if (status.rankingTrendGate?.skipped) {
    const unsupported = status.reasonCodeTelemetry?.unsupportedRunIds || [];
    status.warnings.push(
      unsupported.length > 0
        ? `xtalpi full-suite-ranking-strict trend gate skipped for legacy artifacts without reason-code telemetry: ${unsupported.join(",")}`
        : "xtalpi full-suite-ranking-strict trend gate skipped because no eligible reason-code telemetry was found",
    );
  } else if (status.rankingTrendGate && status.rankingTrendGate.data?.ok === false) {
    const failures = status.rankingTrendGate.data.gateFailures || [];
    status.warnings.push(`xtalpi full-suite-ranking-strict trend gate failed: ${failures.join("; ")}`);
  } else if (status.rankingTrendGate && !status.rankingTrendGate.ok) {
    status.warnings.push("xtalpi full-suite-ranking-strict trend gate failed to run");
  }
  if (status.drift && !status.drift.ok) {
    status.warnings.push("xtalpi full-suite drift summary failed to run");
  }
  status.providerHealthTrend = deriveProviderHealthTrend(status);
  status.result = deriveResult(status);
  return status;
}

module.exports = {
  collectXtalpiSmokeStatus,
  defaultArtifactDir,
  DEFAULT_DRIFT_LIMIT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_STRICT_TREND_LIMIT,
};
