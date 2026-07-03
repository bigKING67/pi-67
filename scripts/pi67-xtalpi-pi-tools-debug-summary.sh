#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "$0")"
SUMMARY_CORE_PATH="$SCRIPT_DIR/pi67-xtalpi-smoke-artifact-core.cjs"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
FORMAT="text"
LATEST_ONLY="0"
RUN_ID=""
HISTORY_LIMIT=""
TREND_GATE_LIMIT=""
COMPARE_BASE_RUN_ID=""
COMPARE_HEAD_RUN_ID=""
FAIL_ON_RECOVERY_INCREASE="0"
MAX_RECOVERY_CASE_RUNS=""
EXPECT_CASES=""
EXPECT_CASE_NAMES=""
MAX_ERRORS="0"
MAX_EMPTY_ASSISTANT_ENDS=""
MAX_RAW_TOOL_MARKUP_FINAL_ANSWERS=""
MAX_RECOVERIES=""
MAX_RECOVERY_RATE=""

usage() {
  cat <<'EOF'
Usage: pi67-xtalpi-pi-tools-debug-summary.sh [--json] [--latest|--run-id RUN_ID] [options] [OUT_DIR]

Summarize xtalpi-pi-tools live smoke artifacts:
  - *.debug.jsonl provider telemetry
  - matching *.jsonl Pi event streams, when present

Selection:
  --latest                       summarize the newest run id
  --run-id RUN_ID                summarize one exact smoke run, e.g. 20260702-144643
  --history N                    show newest N persisted *-summary.json smoke runs
  --trend-gate N                 gate newest N persisted smoke summaries
  --compare BASE_RUN HEAD_RUN    compare two persisted smoke summaries

Gate options:
  --expect-cases N                 require case count for --latest/--run-id and every --trend-gate run
  --expect-case-names LIST          require exact comma-separated case names for --latest/--run-id and --trend-gate
  --max-errors N                  default: 0
  --max-empty-assistant-ends N
  --max-raw-tool-markup-final-answers N
  --max-tool-envelope-final-answers N       alias for --max-raw-tool-markup-final-answers
  --max-recoveries N
  --max-recovery-rate N           recoveries / turns
  --fail-on-recovery-increase     fail if the newest run has more recoveries or a higher recovery rate
  --max-recovery-case-runs N      fail if one case has recoveries in more than N selected runs

Default OUT_DIR:
  $HOME/tmp/xtalpi-pi-tools-smoke
EOF
}

run_self_test() {
  local tmp_dir
  local output
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi67-xtalpi-debug-summary-self-test.XXXXXX")"
  trap "rm -rf '$tmp_dir'" EXIT

  node - "$tmp_dir" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const root = process.argv[2];

function ensureDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(dir, file, events) {
  fs.writeFileSync(path.join(dir, file), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function writeCase(
  dir,
  runId,
  name,
  { finalText = "normal final answer", debugEvents = [], toolNames = [], lifecycle } = {},
) {
  writeJsonl(dir, `${runId}-${name}.jsonl`, [
    ...toolNames.map((toolName) => ({ type: "tool_execution_start", toolName, args: {} })),
    {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          stopReason: "stop",
        },
      ],
    },
  ]);
  writeJsonl(dir, `${runId}-${name}.debug.jsonl`, debugEvents.length ? debugEvents : [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "turn.start",
      event_category: "turn",
      selected_tool_count: toolNames.length,
    },
  ]);
  if (lifecycle) {
    fs.writeFileSync(path.join(dir, `${runId}-${name}.lifecycle.json`), `${JSON.stringify({
      schema: "xtalpi-pi-tools.smoke-lifecycle.v1",
      caseName: name,
      ...lifecycle,
    }, null, 2)}\n`);
  }
}

const clean = ensureDir("clean");
writeCase(clean, "20260702-000001", "clean", {
  toolNames: ["read"],
  debugEvents: [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "turn.start",
      event_category: "turn",
      selected_tool_count: 1,
      tool_selection_clipped: true,
      tool_selection_omitted_count: 2,
      tool_selection_valid_count: 3,
      tool_selection_prompt_source: "recent_user_continuation",
      tool_selection_prompt_chars: 128,
      tool_selection_user_messages: 2,
      data: {
        toolSelectionClipped: true,
        toolSelectionOmittedCount: 2,
        toolSelectionValidCount: 3,
        toolSelectionPromptSource: "recent_user_continuation",
        toolSelectionPromptChars: 128,
        toolSelectionUserMessageCount: 2,
        toolSelectionSummary: {
          schema: "xtalpi-pi-tools.tool-selection.v1",
          validToolCount: 3,
          omittedToolCount: 2,
          selected: [{ name: "read", index: 0, score: 160, selected: true, reasonCodes: ["prompt_tool_name"] }],
          omitted: [{ name: "hidden_admin", index: 1, score: 0, selected: false, reasonCodes: [] }],
        },
      },
    },
  ],
});

const raw = ensureDir("raw");
writeCase(raw, "20260702-000002", "raw", {
  toolNames: ["read"],
  finalText: "<pi_tool_call_history>\nid: call_1\nname: read\n</pi_tool_call_history>",
});

const malformed = ensureDir("malformed");
writeCase(malformed, "20260702-000004", "malformed", {
  toolNames: ["read"],
  finalText: "<pi_tool_call name=\"read\"\n{\"path\":\"package.json\"}",
});

const neutral = ensureDir("neutral-history");
writeCase(neutral, "20260702-000005", "neutral-history", {
  toolNames: ["read"],
  finalText: "[previous_pi_tool_call]\nid: call_1\nname: read\narguments_json: {\"path\":\"package.json\"}\n[/previous_pi_tool_call]",
});

const recovery = ensureDir("recovery");
writeCase(recovery, "20260702-000003", "recovering", {
  debugEvents: [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "turn.start",
      event_category: "turn",
      selected_tool_count: 1,
    },
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "recovery.raw_protocol_markup",
      event_category: "recovery",
      selected_tool_count: 1,
    },
  ],
});

const lifecycle = ensureDir("lifecycle");
writeCase(lifecycle, "20260702-000006", "timed-out-after-agent-end", {
  toolNames: ["web_fetch", "read"],
  lifecycle: {
    exitStatus: 124,
    elapsedSeconds: 42,
    caseTimeoutSeconds: 40,
    timedOutByWatchdog: true,
    agentEndSeenDuringRun: true,
    agentEndElapsedSeconds: 12,
    postAgentEndLingerSeconds: 30,
  },
});

const providerError = ensureDir("provider-error");
writeCase(providerError, "20260702-000007", "http-429", {
  debugEvents: [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "error.provider",
      event_category: "error",
      event_kind: "provider",
      provider: "xtalpi-pi-tools",
      model: "deepseek-v4-pro",
      error_code: "http_429",
      error_category: "rate_limit",
      retryable: true,
      http_status: 429,
      data: {
        errorCode: "http_429",
        errorCategory: "rate_limit",
        retryable: true,
        httpStatus: 429,
      },
    },
  ],
});

const history = ensureDir("history");
function writeSummary(
  runId,
  { dir = history, ok = true, failures = 0, recoveries = 0, raw = 0, errors = 0, cases, totalCases = 5, selectedCases } = {},
) {
  const caseItems = cases || [
    {
      runId,
      caseName: "read",
      turns: 2,
      toolCalls: 1,
      recoveries,
      emptyAssistantEnds: 0,
      rawToolMarkupFinalAnswer: raw > 0,
      toolEnvelopeFinalAnswer: false,
      errors,
      finalTextChars: 42,
      piToolStarts: ["read"],
    },
  ];
  const selectedCaseNames = selectedCases || caseItems.map((item) => item.caseName);
  const normalizedCases = [...new Set(selectedCaseNames)].sort();
  const canonical = normalizedCases.join(",");
  const caseSet = {
    schema: "xtalpi-pi-tools.case-set.v1",
    selectedCases: selectedCaseNames,
    normalizedCases,
    count: normalizedCases.length,
    canonical,
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
  };
  fs.writeFileSync(path.join(dir, `${runId}-summary.json`), `${JSON.stringify({
    schema: "xtalpi-pi-tools.smoke-summary.v1",
    createdAt: "2026-07-02T00:00:00.000Z",
    provider: "xtalpi-pi-tools",
    model: "deepseek-v4-pro",
    stamp: runId,
    runId,
    outDir: dir,
    selectedCases: selectedCaseNames,
    caseSet,
    caseTimeoutSeconds: 180,
    failures,
    debugSummaryStatus: 0,
    ok,
    debugSummary: {
      outDir: dir,
      latestOnly: false,
      runId,
      gateFailures: ok ? [] : ["fixture failure"],
      totals: {
        cases: totalCases,
        debugEvents: 20,
        turns: 10,
        toolCalls: 6,
        recoveries,
        recoveryRate: recoveries / 10,
        emptyAssistantEnds: 0,
        rawToolMarkupFinalAnswers: raw,
        toolEnvelopeFinalAnswers: 0,
        piToolStarts: 6,
        errors,
      },
      cases: caseItems,
    },
  }, null, 2)}\n`);
}
writeSummary("20260702-000001", { ok: true, failures: 0, recoveries: 0 });
writeSummary("20260702-000002", { ok: true, failures: 0, recoveries: 2 });
writeSummary("20260702-000003", { ok: false, failures: 1, recoveries: 1, raw: 1 });
fs.writeFileSync(path.join(history, "20260702-000004-debug-summary.json"), "{}\n");

const trend = ensureDir("trend");
writeSummary("20260702-000001", {
  dir: trend,
  ok: true,
  failures: 0,
  recoveries: 0,
  selectedCases: ["no-tool", "bash", "read", "bash-read", "web-read"],
  cases: [
    {
      runId: "20260702-000001",
      caseName: "web-read",
      turns: 4,
      toolCalls: 3,
      recoveries: 0,
      emptyAssistantEnds: 0,
      rawToolMarkupFinalAnswer: false,
      toolEnvelopeFinalAnswer: false,
      errors: 0,
      piToolStarts: ["web_fetch", "read", "read"],
    },
  ],
});
writeSummary("20260702-000002", {
  dir: trend,
  ok: true,
  failures: 0,
  recoveries: 1,
  selectedCases: ["no-tool", "bash", "read", "bash-read", "web-read"],
  cases: [
    {
      runId: "20260702-000002",
      caseName: "web-read",
      turns: 4,
      toolCalls: 3,
      recoveries: 1,
      emptyAssistantEnds: 0,
      rawToolMarkupFinalAnswer: false,
      toolEnvelopeFinalAnswer: false,
      errors: 0,
      piToolStarts: ["web_fetch", "read", "read"],
    },
  ],
});

const subsetTrend = ensureDir("subset-trend");
writeSummary("20260702-000001", {
  dir: subsetTrend,
  ok: true,
  failures: 0,
  recoveries: 0,
  totalCases: 1,
});
writeSummary("20260702-000002", {
  dir: subsetTrend,
  ok: true,
  failures: 0,
  recoveries: 0,
  totalCases: 1,
});
NODE

  if ! output="$("$SCRIPT_PATH" --run-id 20260702-000001 --expect-cases 1 --expect-case-names clean --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/clean" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"tool_selection_clipped=true"* || "$output" != *"tool_selection_omitted=2-2"* || "$output" != *"tool_selection_valid=3-3"* || "$output" != *"tool_selection_prompt_source=recent_user_continuation"* ]]; then
    echo "clean fixture output did not expose bounded tool-selection diagnostics"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --run-id 20260702-000001 --expect-case-names read "$tmp_dir/clean" 2>&1)"; then
    echo "expected direct case-name gate to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/raw" 2>&1)"; then
    echo "expected raw final-answer fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/malformed" 2>&1)"; then
    echo "expected malformed final-answer fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/neutral-history" 2>&1)"; then
    echo "expected neutral history final-answer fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/recovery" 2>&1)"; then
    echo "expected recovery-threshold fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/lifecycle" 2>&1)"; then
    echo "expected lifecycle timeout fixture to fail"
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"process_lifecycle_failures"* || "$output" != *"timed_out_after_agent_end"* ]]; then
    echo "lifecycle timeout output did not expose process lifecycle diagnostics"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/provider-error" 2>&1)"; then
    echo "expected provider error fixture to fail"
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"provider_errors"* || "$output" != *"provider_error_codes"* || "$output" != *"http_429"* ]]; then
    echo "provider error output did not expose structured provider diagnostics"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --latest --expect-cases 2 "$tmp_dir/clean" 2>&1)"; then
    echo "expected case-count fixture to fail"
    echo "$output"
    return 1
  fi

  local history_json="$tmp_dir/history-output.json"
  if ! output="$("$SCRIPT_PATH" --history 2 --json "$tmp_dir/history" >"$history_json" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if ! node - "$history_json" <<'NODE'; then
const fs = require("node:fs");
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(data.schema === "xtalpi-pi-tools.smoke-history.v1", "unexpected history schema");
assert(data.totalArtifacts === 3, "debug-summary artifact should not be counted as a smoke summary");
assert(data.runs.length === 2, "history limit did not select two runs");
assert(data.runs[0].runId === "20260702-000003", "newest run should be first");
assert(data.runs[1].runId === "20260702-000002", "second newest run should be second");
assert(data.runs[0].ok === false && data.runs[0].failures === 1, "failed run was not visible");
assert(data.runs[0].rawToolMarkupFinalAnswers === 1, "raw final-answer count was not preserved");
assert(data.runs[1].recoveries === 2, "recovery run was not visible");
assert(data.runs[1].caseSet.schema === "xtalpi-pi-tools.case-set.v1", "case set schema missing");
assert(data.runs[1].caseSet.canonical === "read", "case set canonical should use stable case names");
assert(/^[a-f0-9]{64}$/.test(data.runs[1].caseSet.sha256), "case set hash missing");
NODE
    return 1
  fi

  if ! output="$("$SCRIPT_PATH" --history 2 "$tmp_dir/history" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"20260702-000003"* || "$output" != *"20260702-000002"* || "$output" != *"case_set_sha256="* || "$output" == *"20260702-000001"* ]]; then
    echo "history text output did not show only the newest two runs"
    echo "$output"
    return 1
  fi

  local compare_json="$tmp_dir/compare-output.json"
  if ! output="$("$SCRIPT_PATH" --compare 20260702-000002 20260702-000003 --json "$tmp_dir/history" >"$compare_json" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if ! node - "$compare_json" <<'NODE'; then
const fs = require("node:fs");
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(data.schema === "xtalpi-pi-tools.smoke-compare.v1", "unexpected compare schema");
assert(data.baseRunId === "20260702-000002", "unexpected base run id");
assert(data.headRunId === "20260702-000003", "unexpected head run id");
assert(data.delta.failures === 1, "failure delta should show regression");
assert(data.delta.rawToolMarkupFinalAnswers === 1, "raw markup delta should show regression");
assert(data.delta.recoveries === -1, "recovery delta should be head-base");
assert(data.okChanged === true, "ok change should be visible");
assert(data.caseSetChanged === false, "case set should be stable for read-only history fixtures");
assert(data.caseDeltas.some((item) => item.caseName === "read" && item.delta.rawToolMarkupFinalAnswer === true), "case-level raw markup change missing");
NODE
    return 1
  fi

  if ! output="$("$SCRIPT_PATH" --compare 20260702-000002 20260702-000003 "$tmp_dir/history" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"xtalpi-pi-tools smoke compare"* || "$output" != *"failures_delta=1"* || "$output" != *"raw_tool_markup_final_answers_delta=1"* || "$output" != *"case_set_changed=false"* ]]; then
    echo "compare text output did not expose expected regression deltas"
    echo "$output"
    return 1
  fi

  local trend_json="$tmp_dir/trend-output.json"
  if ! output="$("$SCRIPT_PATH" --trend-gate 2 --json "$tmp_dir/trend" >"$trend_json" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if ! node - "$trend_json" <<'NODE'; then
const fs = require("node:fs");
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(data.schema === "xtalpi-pi-tools.smoke-trend-gate.v1", "unexpected trend-gate schema");
assert(data.gateFailures.length === 0, "clean trend gate should pass");
assert(data.history.runs.length === 2, "trend gate should inspect two runs");
assert(data.recoveryTrend.recoveryDelta === 1, "recovery trend should preserve the latest delta");
NODE
    return 1
  fi

  if ! output="$("$SCRIPT_PATH" --trend-gate 2 --expect-cases 5 --expect-case-names no-tool,bash,read,bash-read,web-read "$tmp_dir/trend" 2>&1)"; then
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --trend-gate 2 --expect-case-names no-tool,bash,read,bash-read,tool-result-injection "$tmp_dir/trend" 2>&1)"; then
    echo "expected trend case-name gate to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --trend-gate 2 --expect-cases 5 "$tmp_dir/subset-trend" 2>&1)"; then
    echo "expected subset trend fixture to fail case-count gate"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --trend-gate 2 --max-recoveries 0 "$tmp_dir/trend" 2>&1)"; then
    echo "expected recovery threshold trend gate to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --trend-gate 2 --fail-on-recovery-increase "$tmp_dir/trend" 2>&1)"; then
    echo "expected recovery increase trend gate to fail"
    echo "$output"
    return 1
  fi

  if output="$("$SCRIPT_PATH" --trend-gate 2 "$tmp_dir/history" 2>&1)"; then
    echo "expected failed/raw history trend gate to fail"
    echo "$output"
    return 1
  fi

  echo "xtalpi-pi-tools debug summary self-test passed"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
  exit 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      FORMAT="json"
      shift
      ;;
    --latest)
      LATEST_ONLY="1"
      shift
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --history)
      HISTORY_LIMIT="${2:-}"
      shift 2
      ;;
    --trend-gate)
      if [ "$#" -lt 2 ]; then
        echo "xtalpi-pi-tools debug summary: --trend-gate requires N" >&2
        exit 2
      fi
      TREND_GATE_LIMIT="${2:-}"
      shift 2
      ;;
    --compare)
      if [ "$#" -lt 3 ]; then
        echo "xtalpi-pi-tools debug summary: --compare requires BASE_RUN and HEAD_RUN" >&2
        exit 2
      fi
      COMPARE_BASE_RUN_ID="${2:-}"
      COMPARE_HEAD_RUN_ID="${3:-}"
      shift 3
      ;;
    --expect-cases)
      EXPECT_CASES="${2:-}"
      shift 2
      ;;
    --expect-case-names|--expect-selected-cases)
      EXPECT_CASE_NAMES="${2:-}"
      shift 2
      ;;
    --max-errors)
      MAX_ERRORS="${2:-}"
      shift 2
      ;;
    --max-empty-assistant-ends)
      MAX_EMPTY_ASSISTANT_ENDS="${2:-}"
      shift 2
      ;;
    --max-raw-tool-markup-final-answers|--max-tool-envelope-final-answers)
      MAX_RAW_TOOL_MARKUP_FINAL_ANSWERS="${2:-}"
      shift 2
      ;;
    --max-recoveries)
      MAX_RECOVERIES="${2:-}"
      shift 2
      ;;
    --max-recovery-rate)
      MAX_RECOVERY_RATE="${2:-}"
      shift 2
      ;;
    --fail-on-recovery-increase)
      FAIL_ON_RECOVERY_INCREASE="1"
      shift
      ;;
    --max-recovery-case-runs)
      if [ "$#" -lt 2 ]; then
        echo "xtalpi-pi-tools debug summary: --max-recovery-case-runs requires N" >&2
        exit 2
      fi
      MAX_RECOVERY_CASE_RUNS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      OUT_DIR="$1"
      shift
      ;;
  esac
done

node - \
  "$SUMMARY_CORE_PATH" \
  "$OUT_DIR" \
  "$FORMAT" \
  "$LATEST_ONLY" \
  "$RUN_ID" \
  "$HISTORY_LIMIT" \
  "$TREND_GATE_LIMIT" \
  "$COMPARE_BASE_RUN_ID" \
  "$COMPARE_HEAD_RUN_ID" \
  "$FAIL_ON_RECOVERY_INCREASE" \
  "$MAX_RECOVERY_CASE_RUNS" \
  "$EXPECT_CASES" \
  "$EXPECT_CASE_NAMES" \
  "$MAX_ERRORS" \
  "$MAX_EMPTY_ASSISTANT_ENDS" \
  "$MAX_RAW_TOOL_MARKUP_FINAL_ANSWERS" \
  "$MAX_RECOVERIES" \
  "$MAX_RECOVERY_RATE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [
  summaryCorePath,
  outDir,
  format,
  latestOnlyRaw,
  runIdRaw,
  historyLimitRaw,
  trendGateLimitRaw,
  compareBaseRunIdRaw,
  compareHeadRunIdRaw,
  failOnRecoveryIncreaseRaw,
  maxRecoveryCaseRunsRaw,
  expectCasesRaw,
  expectCaseNamesRaw,
  maxErrorsRaw,
  maxEmptyAssistantEndsRaw,
  maxRawToolMarkupFinalAnswersRaw,
  maxRecoveriesRaw,
  maxRecoveryRateRaw,
] = process.argv.slice(2);
const {
  buildCaseSet,
  containsRawPiToolMarkup,
  isRawToolMarkupFinalAnswer,
  isToolEnvelopeOnlyFinalAnswer,
  normalizeCaseSet,
  numberOrUndefined,
  numberOrZero,
  objectOrUndefined,
  readJsonFile,
  readJsonl,
  sortedUniqueStrings,
  stripPiToolEnvelopes,
  uniqueBooleans,
  uniqueNumbers,
  uniqueStrings,
} = require(summaryCorePath);
const latestOnly = latestOnlyRaw === "1";
const runIdFilter = String(runIdRaw || "").trim();
const failOnRecoveryIncrease = failOnRecoveryIncreaseRaw === "1";
const compareBaseRunId = String(compareBaseRunIdRaw || "").trim();
const compareHeadRunId = String(compareHeadRunIdRaw || "").trim();

function optionalNumber(raw, name) {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`xtalpi-pi-tools debug summary: ${name} must be a non-negative number`);
    process.exit(2);
  }
  return value;
}

function parseCaseNameList(raw, name) {
  if (raw === undefined || raw === "") return undefined;
  const list = String(raw).split(",").map((item) => item.trim());
  if (list.length === 0 || list.some((item) => item === "")) {
    console.error(`xtalpi-pi-tools debug summary: ${name} must be a comma-separated non-empty case list`);
    process.exit(2);
  }
  return sortedUniqueStrings(list);
}

function caseNameListsEqual(actual, expected) {
  const actualSorted = sortedUniqueStrings(actual);
  const expectedSorted = sortedUniqueStrings(expected);
  return actualSorted.length === expectedSorted.length &&
    actualSorted.every((item, index) => item === expectedSorted[index]);
}

function formatCaseNames(values) {
  return sortedUniqueStrings(values).join(",");
}

const gates = {
  expectCases: optionalNumber(expectCasesRaw, "--expect-cases"),
  expectCaseNames: parseCaseNameList(expectCaseNamesRaw, "--expect-case-names"),
  maxErrors: optionalNumber(maxErrorsRaw, "--max-errors"),
  maxEmptyAssistantEnds: optionalNumber(maxEmptyAssistantEndsRaw, "--max-empty-assistant-ends"),
  maxRawToolMarkupFinalAnswers: optionalNumber(
    maxRawToolMarkupFinalAnswersRaw,
    "--max-raw-tool-markup-final-answers",
  ),
  maxRecoveries: optionalNumber(maxRecoveriesRaw, "--max-recoveries"),
  maxRecoveryRate: optionalNumber(maxRecoveryRateRaw, "--max-recovery-rate"),
};

const historyLimit = optionalNumber(historyLimitRaw, "--history");
if (historyLimit !== undefined && (!Number.isInteger(historyLimit) || historyLimit < 1)) {
  console.error("xtalpi-pi-tools debug summary: --history must be a positive integer");
  process.exit(2);
}
const trendGateLimit = optionalNumber(trendGateLimitRaw, "--trend-gate");
if (trendGateLimit !== undefined && (!Number.isInteger(trendGateLimit) || trendGateLimit < 1)) {
  console.error("xtalpi-pi-tools debug summary: --trend-gate must be a positive integer");
  process.exit(2);
}
const maxRecoveryCaseRuns = optionalNumber(maxRecoveryCaseRunsRaw, "--max-recovery-case-runs");
if (
  maxRecoveryCaseRuns !== undefined &&
  (!Number.isInteger(maxRecoveryCaseRuns) || maxRecoveryCaseRuns < 0)
) {
  console.error("xtalpi-pi-tools debug summary: --max-recovery-case-runs must be a non-negative integer");
  process.exit(2);
}
const compareMode = compareBaseRunId !== "" || compareHeadRunId !== "";
if (compareMode && (compareBaseRunId === "" || compareHeadRunId === "")) {
  console.error("xtalpi-pi-tools debug summary: --compare requires BASE_RUN and HEAD_RUN");
  process.exit(2);
}
if (compareMode && (historyLimit !== undefined || trendGateLimit !== undefined)) {
  console.error("xtalpi-pi-tools debug summary: --compare cannot be combined with --history or --trend-gate");
  process.exit(2);
}
if (compareMode && (latestOnly || runIdFilter !== "")) {
  console.error("xtalpi-pi-tools debug summary: --compare cannot be combined with --latest or --run-id");
  process.exit(2);
}
if (historyLimit !== undefined && trendGateLimit !== undefined) {
  console.error("xtalpi-pi-tools debug summary: --history cannot be combined with --trend-gate");
  process.exit(2);
}
if (trendGateLimit !== undefined && (latestOnly || runIdFilter !== "")) {
  console.error("xtalpi-pi-tools debug summary: --trend-gate cannot be combined with --latest or --run-id");
  process.exit(2);
}

function increment(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

function inferCaseParts(fileName) {
  const stem = fileName.replace(/\.debug\.jsonl$/, "");
  const match = stem.match(/^\d{8}-\d{6}-(.+)$/);
  return match ? { runId: stem.slice(0, 15), caseName: match[1] } : { runId: "unknown", caseName: stem };
}

function finalAssistantText(events) {
  const agentEvents = events.filter((event) => event.type === "agent_end");
  const agent = agentEvents.at(-1);
  const final = agent?.messages?.filter((message) => message.role === "assistant").at(-1);
  if (!Array.isArray(final?.content)) return "";
  return final.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function eventData(event) {
  return objectOrUndefined(event?.data) || {};
}

function stringMetric(event, camelName, snakeName) {
  const direct = event?.[snakeName];
  if (typeof direct === "string") return direct;
  const fromData = eventData(event)[camelName];
  return typeof fromData === "string" ? fromData : undefined;
}

function numberMetric(event, camelName, snakeName) {
  const direct = numberOrUndefined(event?.[snakeName]);
  if (direct !== undefined) return direct;
  return numberOrUndefined(eventData(event)[camelName]);
}

function booleanMetric(event, camelName, snakeName) {
  const direct = event?.[snakeName];
  if (typeof direct === "boolean") return direct;
  const fromData = eventData(event)[camelName];
  return typeof fromData === "boolean" ? fromData : undefined;
}

function collectRuntimeFingerprint(events) {
  const turnEvents = events.filter((event) => event.event === "turn.start");
  const sources = turnEvents.length > 0 ? turnEvents : events;
  const selectedToolNames = [];

  for (const event of sources) {
    const names = eventData(event).selectedToolNames;
    if (Array.isArray(names)) {
      selectedToolNames.push(...names.map(String));
    }
  }

  return {
    protocolVersions: uniqueStrings(sources.map((event) => stringMetric(event, "protocolVersion", "protocol_version"))),
    selectedToolNameHashes: uniqueStrings(
      sources.map((event) => stringMetric(event, "selectedToolNamesHash", "selected_tool_names_hash")),
    ),
    selectedToolNames: uniqueStrings(selectedToolNames),
    maxTools: uniqueNumbers(sources.map((event) => numberMetric(event, "maxTools", "max_tools"))),
    toolSelectionClipped: uniqueBooleans(
      sources.map((event) => booleanMetric(event, "toolSelectionClipped", "tool_selection_clipped")),
    ),
    toolSelectionOmittedCount: uniqueNumbers(
      sources.map((event) => numberMetric(event, "toolSelectionOmittedCount", "tool_selection_omitted_count")),
    ),
    toolSelectionValidCount: uniqueNumbers(
      sources.map((event) => numberMetric(event, "toolSelectionValidCount", "tool_selection_valid_count")),
    ),
    toolSelectionPromptSources: uniqueStrings(
      sources.map((event) => stringMetric(event, "toolSelectionPromptSource", "tool_selection_prompt_source")),
    ),
    toolSelectionPromptChars: uniqueNumbers(
      sources.map((event) => numberMetric(event, "toolSelectionPromptChars", "tool_selection_prompt_chars")),
    ),
    toolSelectionUserMessageCount: uniqueNumbers(
      sources.map((event) => numberMetric(event, "toolSelectionUserMessageCount", "tool_selection_user_messages")),
    ),
    maxToolResultChars: uniqueNumbers(
      sources.map((event) => numberMetric(event, "maxToolResultChars", "max_tool_result_chars")),
    ),
    maxOutputTokens: uniqueNumbers(sources.map((event) => numberMetric(event, "maxOutputTokens", "max_output_tokens"))),
    requestTimeoutMs: uniqueNumbers(
      sources.map((event) => numberMetric(event, "requestTimeoutMs", "request_timeout_ms")),
    ),
    maxEmptyRetries: uniqueNumbers(
      sources.map((event) => numberMetric(event, "maxEmptyRetries", "max_empty_retries")),
    ),
    maxRepairRetries: uniqueNumbers(
      sources.map((event) => numberMetric(event, "maxRepairRetries", "max_repair_retries")),
    ),
    maxTotalRecoveries: uniqueNumbers(
      sources.map((event) => numberMetric(event, "maxTotalRecoveries", "max_total_recoveries")),
    ),
  };
}

function summarizeCase(debugFileName) {
  const debugPath = path.join(outDir, debugFileName);
  const mainPath = path.join(outDir, debugFileName.replace(/\.debug\.jsonl$/, ".jsonl"));
  const lifecyclePath = path.join(outDir, debugFileName.replace(/\.debug\.jsonl$/, ".lifecycle.json"));
  const debug = readJsonl(debugPath);
  const main = readJsonl(mainPath);
  const lifecycleParsed = fs.existsSync(lifecyclePath) ? readJsonFile(lifecyclePath) : undefined;
  const lifecycle = lifecycleParsed?.ok ? objectOrUndefined(lifecycleParsed.value) : undefined;

  const recoveryByEvent = {};
  const eventByName = {};
  const selectedToolCounts = [];
  const toolSelectionClippedValues = [];
  const toolSelectionOmittedCounts = [];
  const toolSelectionValidCounts = [];
  for (const event of debug.events) {
    if (typeof event.event === "string") increment(eventByName, event.event);
    if (event.event_category === "recovery" && typeof event.event === "string") {
      increment(recoveryByEvent, event.event);
    }
    if (typeof event.selected_tool_count === "number") {
      selectedToolCounts.push(event.selected_tool_count);
    }
    const selectionClipped = booleanMetric(event, "toolSelectionClipped", "tool_selection_clipped");
    if (selectionClipped !== undefined) toolSelectionClippedValues.push(selectionClipped);
    const selectionOmittedCount = numberMetric(event, "toolSelectionOmittedCount", "tool_selection_omitted_count");
    if (selectionOmittedCount !== undefined) toolSelectionOmittedCounts.push(selectionOmittedCount);
    const selectionValidCount = numberMetric(event, "toolSelectionValidCount", "tool_selection_valid_count");
    if (selectionValidCount !== undefined) toolSelectionValidCounts.push(selectionValidCount);
  }

  const toolStartEvents = main.events.filter((event) => event.type === "tool_execution_start");
  const errors = main.events.filter(
    (event) => event.type === "error" || event.message?.stopReason === "error" || event.message?.errorMessage,
  );
  const emptyAssistantEnds = main.events.filter(
    (event) =>
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      Array.isArray(event.message.content) &&
      event.message.content.length === 0,
  ).length;
  const finalText = finalAssistantText(main.events);
  const rawToolMarkupFinalAnswer = isRawToolMarkupFinalAnswer(finalText);
  const toolEnvelopeFinalAnswer = isToolEnvelopeOnlyFinalAnswer(finalText);
  const finalAnswerQualityOk = finalText.trim().length > 0 && !rawToolMarkupFinalAnswer;
  const hasAgentEnd = main.events.some((event) => event.type === "agent_end");
  const semanticFlowOk = hasAgentEnd && errors.length === 0 && finalAnswerQualityOk;
  const lifecyclePresent = lifecycle !== undefined;
  const exitStatus = lifecyclePresent ? numberOrUndefined(lifecycle.exitStatus) : undefined;
  const processLifecycleOk = lifecyclePresent ? exitStatus === 0 : undefined;
  const elapsedSeconds = lifecyclePresent ? numberOrUndefined(lifecycle.elapsedSeconds) : undefined;
  const caseTimeoutSeconds = lifecyclePresent ? numberOrUndefined(lifecycle.caseTimeoutSeconds) : undefined;
  const timedOutByWatchdog = lifecycle?.timedOutByWatchdog === true;
  const timedOutAfterAgentEnd = timedOutByWatchdog && hasAgentEnd;
  const agentEndElapsedSeconds = lifecyclePresent ? numberOrUndefined(lifecycle.agentEndElapsedSeconds) : undefined;
  const postAgentEndLingerSeconds =
    elapsedSeconds !== undefined && agentEndElapsedSeconds !== undefined
      ? Math.max(0, elapsedSeconds - agentEndElapsedSeconds)
      : undefined;
  const runtimeFingerprint = collectRuntimeFingerprint(debug.events);
  const providerErrorEvents = debug.events.filter((event) => event.event === "error.provider");
  const providerErrorCodes = {};
  const providerErrorCategories = {};
  const providerHttpStatuses = [];
  let retryableProviderErrors = 0;
  for (const event of providerErrorEvents) {
    increment(providerErrorCodes, stringMetric(event, "errorCode", "error_code") || "unknown_error");
    increment(providerErrorCategories, stringMetric(event, "errorCategory", "error_category") || "unknown");
    const httpStatus = numberMetric(event, "httpStatus", "http_status");
    if (httpStatus !== undefined) providerHttpStatuses.push(httpStatus);
    if (booleanMetric(event, "retryable", "retryable") === true) retryableProviderErrors += 1;
  }

  return {
    ...inferCaseParts(debugFileName),
    debugFile: debugPath,
    mainFile: fs.existsSync(mainPath) ? mainPath : undefined,
    lifecycleFile: fs.existsSync(lifecyclePath) ? lifecyclePath : undefined,
    debugEvents: debug.events.length,
    debugParseErrors: debug.parseErrors,
    mainEvents: main.events.length,
    mainParseErrors: main.parseErrors,
    turns: eventByName["turn.start"] ?? 0,
    toolCalls: eventByName.tool_call ?? 0,
    recoveries: Object.values(recoveryByEvent).reduce((sum, value) => sum + value, 0),
    recoveryByEvent,
    piToolStarts: toolStartEvents.map((event) => String(event.toolName || "")),
    errors: errors.length,
    emptyAssistantEnds,
    rawToolMarkupFinalAnswer,
    toolEnvelopeFinalAnswer,
    finalTextChars: finalText.length,
    hasAgentEnd,
    finalAnswerQualityOk,
    semanticFlowOk,
    lifecyclePresent,
    exitStatus,
    processLifecycleOk,
    elapsedSeconds,
    caseTimeoutSeconds,
    timedOutByWatchdog,
    timedOutAfterAgentEnd,
    agentEndElapsedSeconds,
    postAgentEndLingerSeconds,
    runtimeFingerprint,
    providerErrors: providerErrorEvents.length,
    providerErrorCodes,
    providerErrorCategories,
    retryableProviderErrors,
    providerHttpStatuses: uniqueNumbers(providerHttpStatuses),
    selectedToolCountMin: selectedToolCounts.length ? Math.min(...selectedToolCounts) : undefined,
    selectedToolCountMax: selectedToolCounts.length ? Math.max(...selectedToolCounts) : undefined,
    toolSelectionClipped: toolSelectionClippedValues.length ? toolSelectionClippedValues.includes(true) : undefined,
    toolSelectionOmittedCountMin: toolSelectionOmittedCounts.length ? Math.min(...toolSelectionOmittedCounts) : undefined,
    toolSelectionOmittedCountMax: toolSelectionOmittedCounts.length ? Math.max(...toolSelectionOmittedCounts) : undefined,
    toolSelectionValidCountMin: toolSelectionValidCounts.length ? Math.min(...toolSelectionValidCounts) : undefined,
    toolSelectionValidCountMax: toolSelectionValidCounts.length ? Math.max(...toolSelectionValidCounts) : undefined,
  };
}

function summarizeSmokeSummaryFile(fileName) {
  const file = path.join(outDir, fileName);
  const stem = fileName.replace(/-summary\.json$/, "");
  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    return {
      file,
      runId: stem,
      stamp: stem,
      ok: false,
      parseError: parsed.error,
      failures: 0,
      debugSummaryStatus: 1,
      cases: 0,
      recoveries: 0,
      recoveryRate: 0,
      rawToolMarkupFinalAnswers: 0,
      emptyAssistantEnds: 0,
      toolEnvelopeFinalAnswers: 0,
      errors: 0,
      lifecycleArtifacts: 0,
      processLifecycleFailures: 0,
      watchdogTimeouts: 0,
      timedOutAfterAgentEnd: 0,
      semanticFlowOkProcessFailures: 0,
      postAgentEndLingerMaxSeconds: 0,
      providerErrors: 0,
      retryableProviderErrors: 0,
      toolSelectionClippedCases: 0,
      toolSelectionOmittedCountMax: 0,
      providerErrorCodes: {},
      providerErrorCategories: {},
      selectedCases: [],
      caseNames: [],
      caseSet: buildCaseSet([]),
      recoveryCaseNames: [],
      caseRecoveries: [],
      gateFailures: ["summary_parse_error"],
    };
  }

  const artifact = parsed.value;
  const totals = artifact?.debugSummary?.totals ?? {};
  const cases = Array.isArray(artifact?.debugSummary?.cases) ? artifact.debugSummary.cases : [];
  const caseNames = sortedUniqueStrings(cases.map((item) => item?.caseName || "unknown"));
  const selectedCases = Array.isArray(artifact?.selectedCases)
    ? sortedUniqueStrings(artifact.selectedCases)
    : caseNames;
  const caseSet = normalizeCaseSet(artifact?.caseSet, selectedCases);
  const caseRecoveries = cases
    .map((item) => ({
      caseName: String(item?.caseName || "unknown"),
      recoveries: numberOrZero(item?.recoveries),
    }))
    .filter((item) => item.recoveries > 0);
  const gateFailures = Array.isArray(artifact?.debugSummary?.gateFailures)
    ? artifact.debugSummary.gateFailures
    : [];

  return {
    file,
    schema: artifact?.schema,
    ok: artifact?.ok === true,
    provider: artifact?.provider,
    model: artifact?.model,
    stamp: artifact?.stamp || stem,
    runId: artifact?.runId || artifact?.stamp || stem,
    failures: numberOrZero(artifact?.failures),
    debugSummaryStatus: numberOrZero(artifact?.debugSummaryStatus),
    cases: numberOrZero(totals.cases),
    recoveries: numberOrZero(totals.recoveries),
    recoveryRate: numberOrZero(totals.recoveryRate),
    rawToolMarkupFinalAnswers: numberOrZero(totals.rawToolMarkupFinalAnswers),
    emptyAssistantEnds: numberOrZero(totals.emptyAssistantEnds),
    toolEnvelopeFinalAnswers: numberOrZero(totals.toolEnvelopeFinalAnswers),
    errors: numberOrZero(totals.errors),
    lifecycleArtifacts: numberOrZero(totals.lifecycleArtifacts),
    processLifecycleFailures: numberOrZero(totals.processLifecycleFailures),
    watchdogTimeouts: numberOrZero(totals.watchdogTimeouts),
    timedOutAfterAgentEnd: numberOrZero(totals.timedOutAfterAgentEnd),
    semanticFlowOkProcessFailures: numberOrZero(totals.semanticFlowOkProcessFailures),
    postAgentEndLingerMaxSeconds: numberOrZero(totals.postAgentEndLingerMaxSeconds),
    providerErrors: numberOrZero(totals.providerErrors),
    retryableProviderErrors: numberOrZero(totals.retryableProviderErrors),
    toolSelectionClippedCases: numberOrZero(totals.toolSelectionClippedCases),
    toolSelectionOmittedCountMax: numberOrZero(totals.toolSelectionOmittedCountMax),
    providerErrorCodes: objectOrUndefined(totals.providerErrorCodes) || {},
    providerErrorCategories: objectOrUndefined(totals.providerErrorCategories) || {},
    selectedCases: caseSet.normalizedCases,
    caseNames,
    caseSet,
    recoveryCaseNames: caseRecoveries.map((item) => item.caseName),
    caseRecoveries,
    gateFailures,
  };
}

function validateRunId(runId, optionName) {
  if (!/^\d{8}-\d{6}$/.test(runId)) {
    console.error(`xtalpi-pi-tools debug summary: ${optionName} must look like YYYYMMDD-HHMMSS`);
    process.exit(2);
  }
}

function loadSmokeSummaryArtifact(runId, optionName) {
  validateRunId(runId, optionName);
  const fileName = `${runId}-summary.json`;
  const file = path.join(outDir, fileName);
  if (!fs.existsSync(file)) {
    console.error(`xtalpi-pi-tools debug summary: summary artifact not found for ${optionName}: ${file}`);
    process.exit(1);
  }

  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    console.error(`xtalpi-pi-tools debug summary: failed to parse ${file}: ${parsed.error}`);
    process.exit(1);
  }

  return {
    file,
    artifact: parsed.value,
    summary: summarizeSmokeSummaryFile(fileName),
  };
}

function boolValue(value) {
  return value === true;
}

function normalizeCaseForCompare(item) {
  return {
    caseName: String(item?.caseName || "unknown"),
    turns: numberOrZero(item?.turns),
    toolCalls: numberOrZero(item?.toolCalls),
    recoveries: numberOrZero(item?.recoveries),
    emptyAssistantEnds: numberOrZero(item?.emptyAssistantEnds),
    rawToolMarkupFinalAnswer: boolValue(item?.rawToolMarkupFinalAnswer),
    toolEnvelopeFinalAnswer: boolValue(item?.toolEnvelopeFinalAnswer),
    errors: numberOrZero(item?.errors),
    finalTextChars: numberOrZero(item?.finalTextChars),
    processLifecycleOk: item?.processLifecycleOk === undefined ? undefined : boolValue(item?.processLifecycleOk),
    timedOutByWatchdog: boolValue(item?.timedOutByWatchdog),
    timedOutAfterAgentEnd: boolValue(item?.timedOutAfterAgentEnd),
    semanticFlowOk: boolValue(item?.semanticFlowOk),
    elapsedSeconds: item?.elapsedSeconds === undefined ? undefined : numberOrZero(item?.elapsedSeconds),
    postAgentEndLingerSeconds: item?.postAgentEndLingerSeconds === undefined
      ? undefined
      : numberOrZero(item?.postAgentEndLingerSeconds),
    providerErrors: numberOrZero(item?.providerErrors),
    retryableProviderErrors: numberOrZero(item?.retryableProviderErrors),
    toolSelectionClipped: item?.toolSelectionClipped === undefined ? undefined : boolValue(item?.toolSelectionClipped),
    toolSelectionOmittedCountMax: item?.toolSelectionOmittedCountMax === undefined
      ? undefined
      : numberOrZero(item?.toolSelectionOmittedCountMax),
    toolSelectionValidCountMax: item?.toolSelectionValidCountMax === undefined
      ? undefined
      : numberOrZero(item?.toolSelectionValidCountMax),
    piToolStarts: Array.isArray(item?.piToolStarts) ? item.piToolStarts.map(String) : [],
  };
}

function caseMapFromArtifact(artifact) {
  const result = new Map();
  const cases = Array.isArray(artifact?.debugSummary?.cases) ? artifact.debugSummary.cases : [];
  for (const item of cases) {
    const normalized = normalizeCaseForCompare(item);
    result.set(normalized.caseName, normalized);
  }
  return result;
}

function deltaNumber(base, head) {
  return numberOrZero(head) - numberOrZero(base);
}

function deltaSummary(base, head) {
  return {
    failures: deltaNumber(base.failures, head.failures),
    debugSummaryStatus: deltaNumber(base.debugSummaryStatus, head.debugSummaryStatus),
    cases: deltaNumber(base.cases, head.cases),
    recoveries: deltaNumber(base.recoveries, head.recoveries),
    recoveryRate: numberOrZero(head.recoveryRate) - numberOrZero(base.recoveryRate),
    rawToolMarkupFinalAnswers: deltaNumber(base.rawToolMarkupFinalAnswers, head.rawToolMarkupFinalAnswers),
    emptyAssistantEnds: deltaNumber(base.emptyAssistantEnds, head.emptyAssistantEnds),
    toolEnvelopeFinalAnswers: deltaNumber(base.toolEnvelopeFinalAnswers, head.toolEnvelopeFinalAnswers),
    errors: deltaNumber(base.errors, head.errors),
    processLifecycleFailures: deltaNumber(base.processLifecycleFailures, head.processLifecycleFailures),
    watchdogTimeouts: deltaNumber(base.watchdogTimeouts, head.watchdogTimeouts),
    timedOutAfterAgentEnd: deltaNumber(base.timedOutAfterAgentEnd, head.timedOutAfterAgentEnd),
    semanticFlowOkProcessFailures: deltaNumber(
      base.semanticFlowOkProcessFailures,
      head.semanticFlowOkProcessFailures,
    ),
    postAgentEndLingerMaxSeconds: deltaNumber(base.postAgentEndLingerMaxSeconds, head.postAgentEndLingerMaxSeconds),
    providerErrors: deltaNumber(base.providerErrors, head.providerErrors),
    retryableProviderErrors: deltaNumber(base.retryableProviderErrors, head.retryableProviderErrors),
    toolSelectionClippedCases: deltaNumber(base.toolSelectionClippedCases, head.toolSelectionClippedCases),
    toolSelectionOmittedCountMax: deltaNumber(base.toolSelectionOmittedCountMax, head.toolSelectionOmittedCountMax),
  };
}

function changedNumberMap(base, head, keys) {
  const result = {};
  for (const key of keys) {
    const delta = deltaNumber(base?.[key], head?.[key]);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

function changedBooleanMap(base, head, keys) {
  const result = {};
  for (const key of keys) {
    const baseValue = boolValue(base?.[key]);
    const headValue = boolValue(head?.[key]);
    if (baseValue !== headValue) result[key] = headValue;
  }
  return result;
}

function buildCaseDeltas(baseArtifact, headArtifact) {
  const baseCases = caseMapFromArtifact(baseArtifact);
  const headCases = caseMapFromArtifact(headArtifact);
  const names = [...new Set([...baseCases.keys(), ...headCases.keys()])].sort();
  const result = [];

  for (const caseName of names) {
    const baseCase = baseCases.get(caseName);
    const headCase = headCases.get(caseName);
    if (!baseCase) {
      result.push({ caseName, status: "added", base: null, head: headCase, delta: {} });
      continue;
    }
    if (!headCase) {
      result.push({ caseName, status: "removed", base: baseCase, head: null, delta: {} });
      continue;
    }

    const numericDelta = changedNumberMap(baseCase, headCase, [
      "turns",
      "toolCalls",
      "recoveries",
      "emptyAssistantEnds",
      "errors",
      "elapsedSeconds",
      "postAgentEndLingerSeconds",
      "providerErrors",
      "retryableProviderErrors",
      "toolSelectionOmittedCountMax",
      "toolSelectionValidCountMax",
    ]);
    const booleanDelta = changedBooleanMap(baseCase, headCase, [
      "rawToolMarkupFinalAnswer",
      "toolEnvelopeFinalAnswer",
      "processLifecycleOk",
      "timedOutByWatchdog",
      "timedOutAfterAgentEnd",
      "semanticFlowOk",
      "toolSelectionClipped",
    ]);
    const baseTools = baseCase.piToolStarts.join(",");
    const headTools = headCase.piToolStarts.join(",");
    const toolDelta = baseTools === headTools ? {} : { piToolStarts: { base: baseCase.piToolStarts, head: headCase.piToolStarts } };
    const delta = { ...numericDelta, ...booleanDelta, ...toolDelta };
    if (Object.keys(delta).length > 0) {
      result.push({ caseName, status: "changed", base: baseCase, head: headCase, delta });
    }
  }

  return result;
}

function printCompare(baseRunId, headRunId) {
  const base = loadSmokeSummaryArtifact(baseRunId, "--compare BASE_RUN");
  const head = loadSmokeSummaryArtifact(headRunId, "--compare HEAD_RUN");
  const delta = deltaSummary(base.summary, head.summary);
  const caseDeltas = buildCaseDeltas(base.artifact, head.artifact);
  const compare = {
    schema: "xtalpi-pi-tools.smoke-compare.v1",
    outDir,
    baseRunId,
    headRunId,
    base: base.summary,
    head: head.summary,
    delta,
    okChanged: base.summary.ok !== head.summary.ok,
    providerChanged: base.summary.provider !== head.summary.provider,
    modelChanged: base.summary.model !== head.summary.model,
    caseSetChanged: base.summary.caseSet?.sha256 !== head.summary.caseSet?.sha256,
    caseDeltas,
  };

  if (format === "json") {
    console.log(JSON.stringify(compare, null, 2));
  } else {
    console.log("xtalpi-pi-tools smoke compare");
    console.log(`out_dir=${outDir} base=${baseRunId} head=${headRunId}`);
    console.log(
      `base_ok=${base.summary.ok} head_ok=${head.summary.ok} ok_changed=${compare.okChanged} ` +
        `provider_changed=${compare.providerChanged} model_changed=${compare.modelChanged} ` +
        `case_set_changed=${compare.caseSetChanged}`,
    );
    console.log(
      `failures_delta=${delta.failures} cases_delta=${delta.cases} recoveries_delta=${delta.recoveries} ` +
        `recovery_rate_delta=${delta.recoveryRate.toFixed(4)} ` +
        `raw_tool_markup_final_answers_delta=${delta.rawToolMarkupFinalAnswers} ` +
        `empty_assistant_ends_delta=${delta.emptyAssistantEnds} ` +
        `tool_envelope_final_answers_delta=${delta.toolEnvelopeFinalAnswers} ` +
        `errors_delta=${delta.errors} process_lifecycle_failures_delta=${delta.processLifecycleFailures} ` +
        `watchdog_timeouts_delta=${delta.watchdogTimeouts} ` +
        `timed_out_after_agent_end_delta=${delta.timedOutAfterAgentEnd} ` +
        `provider_errors_delta=${delta.providerErrors} retryable_provider_errors_delta=${delta.retryableProviderErrors} ` +
        `tool_selection_clipped_cases_delta=${delta.toolSelectionClippedCases} ` +
        `tool_selection_omitted_count_max_delta=${delta.toolSelectionOmittedCountMax} ` +
        `debug_summary_status_delta=${delta.debugSummaryStatus}`,
    );
    if (caseDeltas.length === 0) {
      console.log("case_deltas=none");
    } else {
      console.log("case_deltas:");
      for (const item of caseDeltas) {
        console.log(`- ${item.caseName}: status=${item.status} delta=${JSON.stringify(item.delta)}`);
      }
    }
  }

  process.exit(0);
}

function listSmokeSummaryFiles() {
  return fs.readdirSync(outDir)
    .filter((file) => /^\d{8}-\d{6}-summary\.json$/.test(file))
    .sort();
}

function buildHistory(limit) {
  const summaryFiles = listSmokeSummaryFiles();

  if (summaryFiles.length === 0) {
    console.error(`xtalpi-pi-tools debug summary: no *-summary.json files found in ${outDir}`);
    process.exit(1);
  }

  const selectedFiles = summaryFiles.slice(-limit).reverse();
  const runs = selectedFiles.map(summarizeSmokeSummaryFile);
  const parseErrorCount = runs.filter((run) => run.parseError).length;

  return {
    schema: "xtalpi-pi-tools.smoke-history.v1",
    outDir,
    requested: limit,
    totalArtifacts: summaryFiles.length,
    found: runs.length,
    order: "newest_first",
    parseErrorCount,
    runs,
  };
}

function printHistory(limit) {
  const history = buildHistory(limit);
  const { runs } = history;

  if (format === "json") {
    console.log(JSON.stringify(history, null, 2));
  } else {
    console.log("xtalpi-pi-tools smoke history");
    console.log(
      `out_dir=${outDir} requested=${history.requested} found=${history.found} total_artifacts=${history.totalArtifacts} ` +
        "order=newest_first",
    );
    for (const run of runs) {
      const parseText = run.parseError ? ` parse_error=${JSON.stringify(run.parseError)}` : "";
      const gateText = run.gateFailures?.length ? ` gate_failures=${JSON.stringify(run.gateFailures)}` : "";
      const providerText = run.provider ? ` provider=${run.provider}` : "";
      const modelText = run.model ? ` model=${run.model}` : "";
      const selectedText = run.selectedCases?.length ? ` selected_cases=${run.selectedCases.join(",")}` : "";
      const caseSetText = run.caseSet?.sha256 ? ` case_set_sha256=${run.caseSet.sha256}` : "";
      console.log(
        `- ${run.runId}: ok=${run.ok} failures=${run.failures} cases=${run.cases} ` +
          `recoveries=${run.recoveries} recovery_rate=${run.recoveryRate.toFixed(4)} ` +
          `raw_tool_markup_final_answers=${run.rawToolMarkupFinalAnswers} ` +
          `empty_assistant_ends=${run.emptyAssistantEnds} ` +
          `tool_envelope_final_answers=${run.toolEnvelopeFinalAnswers} ` +
          `errors=${run.errors} process_lifecycle_failures=${run.processLifecycleFailures} ` +
          `watchdog_timeouts=${run.watchdogTimeouts} timed_out_after_agent_end=${run.timedOutAfterAgentEnd} ` +
          `provider_errors=${run.providerErrors} retryable_provider_errors=${run.retryableProviderErrors} ` +
          `tool_selection_clipped_cases=${run.toolSelectionClippedCases} ` +
          `tool_selection_omitted_count_max=${run.toolSelectionOmittedCountMax} ` +
          `debug_summary_status=${run.debugSummaryStatus}` +
          `${providerText}${modelText}${selectedText}${caseSetText}${gateText}${parseText}`,
      );
    }
  }

  process.exit(history.parseErrorCount > 0 ? 1 : 0);
}

function buildRecoveryTrend(runs) {
  const latest = runs[0];
  const previous = runs[1];
  const latestRecoveries = numberOrZero(latest?.recoveries);
  const previousRecoveries = numberOrZero(previous?.recoveries);
  const latestRecoveryRate = numberOrZero(latest?.recoveryRate);
  const previousRecoveryRate = numberOrZero(previous?.recoveryRate);

  return {
    latestRunId: latest?.runId,
    previousRunId: previous?.runId,
    latestRecoveries,
    previousRecoveries,
    recoveryDelta: previous ? latestRecoveries - previousRecoveries : 0,
    latestRecoveryRate,
    previousRecoveryRate,
    recoveryRateDelta: previous ? latestRecoveryRate - previousRecoveryRate : 0,
  };
}

function buildRecoveryCaseRunCounts(runs) {
  const result = {};
  for (const run of runs) {
    const names = new Set(Array.isArray(run.recoveryCaseNames) ? run.recoveryCaseNames : []);
    for (const name of names) {
      result[name] = (result[name] ?? 0) + 1;
    }
  }
  return result;
}

function evaluateTrendGate(history) {
  const hardLimits = {
    expectCases: gates.expectCases,
    expectCaseNames: gates.expectCaseNames,
    maxErrors: gates.maxErrors ?? 0,
    maxEmptyAssistantEnds: gates.maxEmptyAssistantEnds ?? 0,
    maxRawToolMarkupFinalAnswers: gates.maxRawToolMarkupFinalAnswers ?? 0,
    maxToolEnvelopeFinalAnswers: gates.maxRawToolMarkupFinalAnswers ?? 0,
    maxRecoveries: gates.maxRecoveries,
    maxRecoveryRate: gates.maxRecoveryRate,
    maxRecoveryCaseRuns,
    failOnRecoveryIncrease,
  };
  const gateFailures = [];

  for (const run of history.runs) {
    if (run.parseError) {
      gateFailures.push(`${run.runId}: summary parse error`);
      continue;
    }
    if (run.ok !== true) {
      gateFailures.push(`${run.runId}: expected ok=true, got ${run.ok}`);
    }
    if (run.failures > 0) {
      gateFailures.push(`${run.runId}: expected failures=0, got ${run.failures}`);
    }
    if (run.debugSummaryStatus > 0) {
      gateFailures.push(`${run.runId}: expected debug_summary_status=0, got ${run.debugSummaryStatus}`);
    }
    if (hardLimits.expectCases !== undefined && run.cases !== hardLimits.expectCases) {
      gateFailures.push(`${run.runId}: expected cases=${hardLimits.expectCases}, got ${run.cases}`);
    }
    if (
      hardLimits.expectCaseNames !== undefined &&
      !caseNameListsEqual(run.selectedCases, hardLimits.expectCaseNames)
    ) {
      gateFailures.push(
        `${run.runId}: expected case_names=${formatCaseNames(hardLimits.expectCaseNames)}, got ${formatCaseNames(run.selectedCases)}`,
      );
    }
    if (run.errors > hardLimits.maxErrors) {
      gateFailures.push(`${run.runId}: expected errors<=${hardLimits.maxErrors}, got ${run.errors}`);
    }
    if (run.processLifecycleFailures > 0) {
      gateFailures.push(`${run.runId}: expected process_lifecycle_failures=0, got ${run.processLifecycleFailures}`);
    }
    if (run.providerErrors > 0) {
      gateFailures.push(`${run.runId}: expected provider_errors=0, got ${run.providerErrors}`);
    }
    if (run.emptyAssistantEnds > hardLimits.maxEmptyAssistantEnds) {
      gateFailures.push(
        `${run.runId}: expected empty_assistant_ends<=${hardLimits.maxEmptyAssistantEnds}, got ${run.emptyAssistantEnds}`,
      );
    }
    if (run.rawToolMarkupFinalAnswers > hardLimits.maxRawToolMarkupFinalAnswers) {
      gateFailures.push(
        `${run.runId}: expected raw_tool_markup_final_answers<=${hardLimits.maxRawToolMarkupFinalAnswers}, got ${run.rawToolMarkupFinalAnswers}`,
      );
    }
    if (run.toolEnvelopeFinalAnswers > hardLimits.maxToolEnvelopeFinalAnswers) {
      gateFailures.push(
        `${run.runId}: expected tool_envelope_final_answers<=${hardLimits.maxToolEnvelopeFinalAnswers}, got ${run.toolEnvelopeFinalAnswers}`,
      );
    }
    if (hardLimits.maxRecoveries !== undefined && run.recoveries > hardLimits.maxRecoveries) {
      gateFailures.push(`${run.runId}: expected recoveries<=${hardLimits.maxRecoveries}, got ${run.recoveries}`);
    }
    if (hardLimits.maxRecoveryRate !== undefined && run.recoveryRate > hardLimits.maxRecoveryRate) {
      gateFailures.push(
        `${run.runId}: expected recovery_rate<=${hardLimits.maxRecoveryRate}, got ${run.recoveryRate.toFixed(4)}`,
      );
    }
  }

  const recoveryTrend = buildRecoveryTrend(history.runs);
  if (
    hardLimits.failOnRecoveryIncrease &&
    recoveryTrend.previousRunId &&
    (recoveryTrend.recoveryDelta > 0 || recoveryTrend.recoveryRateDelta > 0)
  ) {
    gateFailures.push(
      `recovery increased: ${recoveryTrend.previousRunId}->${recoveryTrend.latestRunId} ` +
        `recoveries_delta=${recoveryTrend.recoveryDelta} recovery_rate_delta=${recoveryTrend.recoveryRateDelta.toFixed(4)}`,
    );
  }

  const recoveryCaseRunCounts = buildRecoveryCaseRunCounts(history.runs);
  const repeatedRecoveryCases = Object.entries(recoveryCaseRunCounts)
    .filter(([, count]) => count > 1)
    .map(([caseName, runCount]) => ({ caseName, runCount }));
  if (hardLimits.maxRecoveryCaseRuns !== undefined) {
    for (const [caseName, runCount] of Object.entries(recoveryCaseRunCounts)) {
      if (runCount > hardLimits.maxRecoveryCaseRuns) {
        gateFailures.push(
          `${caseName}: expected recovery_case_runs<=${hardLimits.maxRecoveryCaseRuns}, got ${runCount}`,
        );
      }
    }
  }

  return {
    limits: hardLimits,
    recoveryTrend,
    recoveryCaseRunCounts,
    repeatedRecoveryCases,
    gateFailures,
  };
}

function printTrendGate(limit) {
  const history = buildHistory(limit);
  const evaluation = evaluateTrendGate(history);
  const trendGate = {
    schema: "xtalpi-pi-tools.smoke-trend-gate.v1",
    outDir,
    requested: history.requested,
    totalArtifacts: history.totalArtifacts,
    found: history.found,
    order: history.order,
    ok: evaluation.gateFailures.length === 0,
    ...evaluation,
    history,
  };

  if (format === "json") {
    console.log(JSON.stringify(trendGate, null, 2));
  } else {
    console.log("xtalpi-pi-tools smoke trend gate");
    console.log(
      `out_dir=${outDir} requested=${history.requested} found=${history.found} ` +
        `total_artifacts=${history.totalArtifacts} order=${history.order} ok=${trendGate.ok}`,
    );
    console.log(
      `latest=${evaluation.recoveryTrend.latestRunId || "(none)"} ` +
        `previous=${evaluation.recoveryTrend.previousRunId || "(none)"} ` +
        `recoveries_delta=${evaluation.recoveryTrend.recoveryDelta} ` +
        `recovery_rate_delta=${evaluation.recoveryTrend.recoveryRateDelta.toFixed(4)}`,
    );
    if (evaluation.repeatedRecoveryCases.length > 0) {
      console.log(`repeated_recovery_cases=${JSON.stringify(evaluation.repeatedRecoveryCases)}`);
    }
    if (evaluation.gateFailures.length > 0) {
      console.error(`gate_failures=${JSON.stringify(evaluation.gateFailures)}`);
    }
  }

  process.exit(evaluation.gateFailures.length > 0 ? 1 : 0);
}

if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
  console.error(`xtalpi-pi-tools debug summary: directory not found: ${outDir}`);
  process.exit(1);
}

if (historyLimit !== undefined) {
  printHistory(historyLimit);
}

if (trendGateLimit !== undefined) {
  printTrendGate(trendGateLimit);
}

if (compareMode) {
  printCompare(compareBaseRunId, compareHeadRunId);
}

let debugFiles = fs.readdirSync(outDir)
  .filter((file) => file.endsWith(".debug.jsonl"))
  .sort();

if (debugFiles.length === 0) {
  console.error(`xtalpi-pi-tools debug summary: no *.debug.jsonl files found in ${outDir}`);
  process.exit(1);
}

let selectedRunId = runIdFilter || undefined;
if (runIdFilter) {
  debugFiles = debugFiles.filter((file) => file.startsWith(`${runIdFilter}-`));
} else if (latestOnly) {
  const runIds = debugFiles
    .map((file) => file.match(/^(\d{8}-\d{6})-/)?.[1])
    .filter(Boolean)
    .sort();
  const latestRunId = runIds.at(-1);
  if (latestRunId) {
    selectedRunId = latestRunId;
    debugFiles = debugFiles.filter((file) => file.startsWith(`${latestRunId}-`));
  }
}

if (debugFiles.length === 0) {
  const selector = runIdFilter ? `run id ${runIdFilter}` : "selection";
  console.error(`xtalpi-pi-tools debug summary: no *.debug.jsonl files matched ${selector} in ${outDir}`);
  process.exit(1);
}

const cases = debugFiles.map(summarizeCase);
const totals = {
  cases: cases.length,
  debugEvents: 0,
  debugParseErrors: 0,
  mainParseErrors: 0,
  turns: 0,
  toolCalls: 0,
  recoveries: 0,
  emptyAssistantEnds: 0,
  rawToolMarkupFinalAnswers: 0,
  toolEnvelopeFinalAnswers: 0,
  piToolStarts: 0,
  errors: 0,
  lifecycleArtifacts: 0,
  processLifecycleFailures: 0,
  watchdogTimeouts: 0,
  timedOutAfterAgentEnd: 0,
  semanticFlowOkProcessFailures: 0,
  postAgentEndLingerMaxSeconds: 0,
  providerErrors: 0,
  retryableProviderErrors: 0,
  toolSelectionClippedCases: 0,
  toolSelectionOmittedCountMax: 0,
  providerErrorCodes: {},
  providerErrorCategories: {},
  recoveryByEvent: {},
};

for (const item of cases) {
  totals.debugEvents += item.debugEvents;
  totals.debugParseErrors += item.debugParseErrors;
  totals.mainParseErrors += item.mainParseErrors;
  totals.turns += item.turns;
  totals.toolCalls += item.toolCalls;
  totals.recoveries += item.recoveries;
  totals.emptyAssistantEnds += item.emptyAssistantEnds;
  totals.rawToolMarkupFinalAnswers += item.rawToolMarkupFinalAnswer ? 1 : 0;
  totals.toolEnvelopeFinalAnswers += item.toolEnvelopeFinalAnswer ? 1 : 0;
  totals.piToolStarts += item.piToolStarts.length;
  totals.errors += item.errors;
  totals.lifecycleArtifacts += item.lifecyclePresent ? 1 : 0;
  totals.processLifecycleFailures += item.processLifecycleOk === false ? 1 : 0;
  totals.watchdogTimeouts += item.timedOutByWatchdog ? 1 : 0;
  totals.timedOutAfterAgentEnd += item.timedOutAfterAgentEnd ? 1 : 0;
  totals.semanticFlowOkProcessFailures += item.semanticFlowOk && item.processLifecycleOk === false ? 1 : 0;
  totals.providerErrors += item.providerErrors;
  totals.retryableProviderErrors += item.retryableProviderErrors;
  totals.toolSelectionClippedCases += item.toolSelectionClipped === true ? 1 : 0;
  if (item.toolSelectionOmittedCountMax !== undefined) {
    totals.toolSelectionOmittedCountMax = Math.max(totals.toolSelectionOmittedCountMax, item.toolSelectionOmittedCountMax);
  }
  if (typeof item.postAgentEndLingerSeconds === "number") {
    totals.postAgentEndLingerMaxSeconds = Math.max(totals.postAgentEndLingerMaxSeconds, item.postAgentEndLingerSeconds);
  }
  for (const [code, count] of Object.entries(item.providerErrorCodes)) {
    increment(totals.providerErrorCodes, code, count);
  }
  for (const [category, count] of Object.entries(item.providerErrorCategories)) {
    increment(totals.providerErrorCategories, category, count);
  }
  for (const [event, count] of Object.entries(item.recoveryByEvent)) {
    increment(totals.recoveryByEvent, event, count);
  }
}

totals.recoveryRate = totals.turns > 0 ? totals.recoveries / totals.turns : 0;

const gateFailures = [];
if (gates.expectCases !== undefined && totals.cases !== gates.expectCases) {
  gateFailures.push(`expected cases=${gates.expectCases}, got ${totals.cases}`);
}
if (
  gates.expectCaseNames !== undefined &&
  !caseNameListsEqual(cases.map((item) => item.caseName), gates.expectCaseNames)
) {
  gateFailures.push(
    `expected case_names=${formatCaseNames(gates.expectCaseNames)}, got ${formatCaseNames(cases.map((item) => item.caseName))}`,
  );
}
if (gates.maxErrors !== undefined && totals.errors > gates.maxErrors) {
  gateFailures.push(`expected errors<=${gates.maxErrors}, got ${totals.errors}`);
}
if (totals.debugParseErrors > 0 || totals.mainParseErrors > 0) {
  gateFailures.push(`expected parse_errors=0, got debug=${totals.debugParseErrors} main=${totals.mainParseErrors}`);
}
if (totals.processLifecycleFailures > 0) {
  gateFailures.push(`expected process_lifecycle_failures=0, got ${totals.processLifecycleFailures}`);
}
if (totals.providerErrors > 0) {
  gateFailures.push(`expected provider_errors=0, got ${totals.providerErrors}`);
}
if (gates.maxEmptyAssistantEnds !== undefined && totals.emptyAssistantEnds > gates.maxEmptyAssistantEnds) {
  gateFailures.push(`expected empty_assistant_ends<=${gates.maxEmptyAssistantEnds}, got ${totals.emptyAssistantEnds}`);
}
if (
  gates.maxRawToolMarkupFinalAnswers !== undefined &&
  totals.rawToolMarkupFinalAnswers > gates.maxRawToolMarkupFinalAnswers
) {
  gateFailures.push(
    `expected raw_tool_markup_final_answers<=${gates.maxRawToolMarkupFinalAnswers}, got ${totals.rawToolMarkupFinalAnswers}`,
  );
}
if (gates.maxRecoveries !== undefined && totals.recoveries > gates.maxRecoveries) {
  gateFailures.push(`expected recoveries<=${gates.maxRecoveries}, got ${totals.recoveries}`);
}
if (gates.maxRecoveryRate !== undefined && totals.recoveryRate > gates.maxRecoveryRate) {
  gateFailures.push(`expected recovery_rate<=${gates.maxRecoveryRate}, got ${totals.recoveryRate.toFixed(4)}`);
}

const summary = { outDir, latestOnly, runId: selectedRunId, gates, gateFailures, totals, cases };

if (format === "json") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("xtalpi-pi-tools debug summary");
  console.log(`out_dir=${outDir} latest_only=${latestOnly} run_id=${selectedRunId || "(all)"}`);
  console.log(
    `cases=${totals.cases} debug_events=${totals.debugEvents} turns=${totals.turns} ` +
      `tool_calls=${totals.toolCalls} recoveries=${totals.recoveries} recovery_rate=${totals.recoveryRate.toFixed(4)} ` +
      `empty_assistant_ends=${totals.emptyAssistantEnds} raw_tool_markup_final_answers=${totals.rawToolMarkupFinalAnswers} ` +
      `tool_envelope_final_answers=${totals.toolEnvelopeFinalAnswers} ` +
      `pi_tool_starts=${totals.piToolStarts} errors=${totals.errors} ` +
      `lifecycle_artifacts=${totals.lifecycleArtifacts} process_lifecycle_failures=${totals.processLifecycleFailures} ` +
      `watchdog_timeouts=${totals.watchdogTimeouts} timed_out_after_agent_end=${totals.timedOutAfterAgentEnd} ` +
      `semantic_flow_ok_process_failures=${totals.semanticFlowOkProcessFailures} ` +
      `post_agent_end_linger_max_seconds=${totals.postAgentEndLingerMaxSeconds} ` +
      `provider_errors=${totals.providerErrors} retryable_provider_errors=${totals.retryableProviderErrors} ` +
      `tool_selection_clipped_cases=${totals.toolSelectionClippedCases} ` +
      `tool_selection_omitted_count_max=${totals.toolSelectionOmittedCountMax}`,
  );
  if (Object.keys(totals.providerErrorCodes).length > 0) {
    console.log(`provider_error_codes=${JSON.stringify(totals.providerErrorCodes)}`);
  }
  if (Object.keys(totals.providerErrorCategories).length > 0) {
    console.log(`provider_error_categories=${JSON.stringify(totals.providerErrorCategories)}`);
  }
  if (Object.keys(totals.recoveryByEvent).length > 0) {
    console.log(`recovery_by_event=${JSON.stringify(totals.recoveryByEvent)}`);
  }
  for (const item of cases) {
    const recoveryText = Object.keys(item.recoveryByEvent).length > 0
      ? ` recovery_by_event=${JSON.stringify(item.recoveryByEvent)}`
      : "";
    const toolText = item.piToolStarts.length > 0 ? ` pi_tools=${item.piToolStarts.join(",")}` : "";
    const selectedText = item.selectedToolCountMax !== undefined
      ? ` selected_tools=${item.selectedToolCountMin}-${item.selectedToolCountMax}`
      : "";
    const selectionText = item.toolSelectionClipped === true || item.toolSelectionOmittedCountMax !== undefined
      ? ` tool_selection_clipped=${item.toolSelectionClipped}` +
        ` tool_selection_omitted=${item.toolSelectionOmittedCountMin ?? "(unknown)"}-${item.toolSelectionOmittedCountMax ?? "(unknown)"}` +
        ` tool_selection_valid=${item.toolSelectionValidCountMin ?? "(unknown)"}-${item.toolSelectionValidCountMax ?? "(unknown)"}`
      : "";
    const toolSelectionPromptSources = item.runtimeFingerprint?.toolSelectionPromptSources || [];
    const promptSourceText = toolSelectionPromptSources.length
      ? ` tool_selection_prompt_source=${toolSelectionPromptSources.join("|")}`
      : "";
    const providerErrorText = item.providerErrors > 0
      ? ` provider_errors=${item.providerErrors}` +
        ` retryable_provider_errors=${item.retryableProviderErrors}` +
        ` provider_error_codes=${JSON.stringify(item.providerErrorCodes)}` +
        ` provider_error_categories=${JSON.stringify(item.providerErrorCategories)}` +
        ` provider_http_statuses=${item.providerHttpStatuses.join(",") || "(none)"}`
      : "";
    const lifecycleText = item.lifecyclePresent
      ? ` process_lifecycle_ok=${item.processLifecycleOk}` +
        ` timed_out_by_watchdog=${item.timedOutByWatchdog}` +
        ` timed_out_after_agent_end=${item.timedOutAfterAgentEnd}` +
        ` semantic_flow_ok=${item.semanticFlowOk}` +
        ` elapsed_seconds=${item.elapsedSeconds ?? "(unknown)"}` +
        ` post_agent_end_linger_seconds=${item.postAgentEndLingerSeconds ?? "(unknown)"}`
      : "";
    console.log(
      `- ${item.runId}/${item.caseName}: debug_events=${item.debugEvents} turns=${item.turns} tool_calls=${item.toolCalls}` +
        ` recoveries=${item.recoveries} empty_assistant_ends=${item.emptyAssistantEnds}` +
        ` raw_tool_markup_final_answer=${item.rawToolMarkupFinalAnswer}` +
        ` tool_envelope_final_answer=${item.toolEnvelopeFinalAnswer}${recoveryText}${toolText}${selectedText}${selectionText}` +
        `${promptSourceText}${providerErrorText}${lifecycleText}` +
        ` final_text_chars=${item.finalTextChars}`,
    );
  }
  if (gateFailures.length > 0) {
    console.error(`gate_failures=${JSON.stringify(gateFailures)}`);
  }
}

process.exit(gateFailures.length > 0 ? 1 : 0);
NODE
