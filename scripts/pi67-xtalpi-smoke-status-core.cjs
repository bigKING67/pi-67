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
    runs: historyRuns.map(compactRun),
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
  if (status.drift && !status.drift.ok) {
    status.warnings.push("xtalpi full-suite drift summary failed to run");
  }
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
