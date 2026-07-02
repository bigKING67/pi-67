#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
FORMAT="text"
LATEST_ONLY="0"
RUN_ID=""
HISTORY_LIMIT=""
EXPECT_CASES=""
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

Gate options:
  --expect-cases N
  --max-errors N                  default: 0
  --max-empty-assistant-ends N
  --max-raw-tool-markup-final-answers N
  --max-tool-envelope-final-answers N       alias for --max-raw-tool-markup-final-answers
  --max-recoveries N
  --max-recovery-rate N           recoveries / turns

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

function writeCase(dir, runId, name, { finalText = "normal final answer", debugEvents = [], toolNames = [] } = {}) {
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
}

const clean = ensureDir("clean");
writeCase(clean, "20260702-000001", "clean", { toolNames: ["read"] });

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

const history = ensureDir("history");
function writeSummary(runId, { ok = true, failures = 0, recoveries = 0, raw = 0, errors = 0 } = {}) {
  fs.writeFileSync(path.join(history, `${runId}-summary.json`), `${JSON.stringify({
    schema: "xtalpi-pi-tools.smoke-summary.v1",
    createdAt: "2026-07-02T00:00:00.000Z",
    provider: "xtalpi-pi-tools",
    model: "deepseek-v4-pro",
    stamp: runId,
    runId,
    outDir: history,
    caseTimeoutSeconds: 180,
    failures,
    debugSummaryStatus: 0,
    ok,
    debugSummary: {
      outDir: history,
      latestOnly: false,
      runId,
      gateFailures: ok ? [] : ["fixture failure"],
      totals: {
        cases: 5,
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
      cases: [],
    },
  }, null, 2)}\n`);
}
writeSummary("20260702-000001", { ok: true, failures: 0, recoveries: 0 });
writeSummary("20260702-000002", { ok: true, failures: 0, recoveries: 2 });
writeSummary("20260702-000003", { ok: false, failures: 1, recoveries: 1, raw: 1 });
fs.writeFileSync(path.join(history, "20260702-000004-debug-summary.json"), "{}\n");
NODE

  if ! output="$("$SCRIPT_PATH" --run-id 20260702-000001 --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/clean" 2>&1)"; then
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

  if output="$("$SCRIPT_PATH" --latest --expect-cases 1 --max-errors 0 --max-empty-assistant-ends 0 --max-raw-tool-markup-final-answers 0 --max-recoveries 0 "$tmp_dir/recovery" 2>&1)"; then
    echo "expected recovery-threshold fixture to fail"
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
NODE
    return 1
  fi

  if ! output="$("$SCRIPT_PATH" --history 2 "$tmp_dir/history" 2>&1)"; then
    echo "$output"
    return 1
  fi
  if [[ "$output" != *"20260702-000003"* || "$output" != *"20260702-000002"* || "$output" == *"20260702-000001"* ]]; then
    echo "history text output did not show only the newest two runs"
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
    --expect-cases)
      EXPECT_CASES="${2:-}"
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
  "$OUT_DIR" \
  "$FORMAT" \
  "$LATEST_ONLY" \
  "$RUN_ID" \
  "$HISTORY_LIMIT" \
  "$EXPECT_CASES" \
  "$MAX_ERRORS" \
  "$MAX_EMPTY_ASSISTANT_ENDS" \
  "$MAX_RAW_TOOL_MARKUP_FINAL_ANSWERS" \
  "$MAX_RECOVERIES" \
  "$MAX_RECOVERY_RATE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [
  outDir,
  format,
  latestOnlyRaw,
  runIdRaw,
  historyLimitRaw,
  expectCasesRaw,
  maxErrorsRaw,
  maxEmptyAssistantEndsRaw,
  maxRawToolMarkupFinalAnswersRaw,
  maxRecoveriesRaw,
  maxRecoveryRateRaw,
] = process.argv.slice(2);
const latestOnly = latestOnlyRaw === "1";
const runIdFilter = String(runIdRaw || "").trim();

function optionalNumber(raw, name) {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`xtalpi-pi-tools debug summary: ${name} must be a non-negative number`);
    process.exit(2);
  }
  return value;
}

const gates = {
  expectCases: optionalNumber(expectCasesRaw, "--expect-cases"),
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

function readJsonl(file) {
  const result = { events: [], parseErrors: 0 };
  if (!fs.existsSync(file)) return result;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return result;
  for (const line of raw.split(/\n/).filter(Boolean)) {
    try {
      result.events.push(JSON.parse(line));
    } catch {
      result.parseErrors += 1;
    }
  }
  return result;
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

function stripPiToolEnvelopes(text) {
  return String(text || "")
    .replace(/<pi_tool_call_history\b[^>]*>[\s\S]*?<\/pi_tool_call_history>/g, "")
    .replace(/<pi_tool_call\b[^>]*>[\s\S]*?<\/pi_tool_call>/g, "")
    .replace(/<pi_tool_result\b[^>]*>[\s\S]*?<\/pi_tool_result>/g, "")
    .trim();
}

function containsRawPiToolMarkup(text) {
  return /<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))/i.test(String(text || ""));
}

function isRawToolMarkupFinalAnswer(text) {
  const trimmed = String(text || "").trim();
  return containsRawPiToolMarkup(trimmed);
}

function isToolEnvelopeOnlyFinalAnswer(text) {
  const trimmed = String(text || "").trim();
  return containsRawPiToolMarkup(trimmed) && stripPiToolEnvelopes(trimmed).length === 0;
}

function summarizeCase(debugFileName) {
  const debugPath = path.join(outDir, debugFileName);
  const mainPath = path.join(outDir, debugFileName.replace(/\.debug\.jsonl$/, ".jsonl"));
  const debug = readJsonl(debugPath);
  const main = readJsonl(mainPath);

  const recoveryByEvent = {};
  const eventByName = {};
  const selectedToolCounts = [];
  for (const event of debug.events) {
    if (typeof event.event === "string") increment(eventByName, event.event);
    if (event.event_category === "recovery" && typeof event.event === "string") {
      increment(recoveryByEvent, event.event);
    }
    if (typeof event.selected_tool_count === "number") {
      selectedToolCounts.push(event.selected_tool_count);
    }
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

  return {
    ...inferCaseParts(debugFileName),
    debugFile: debugPath,
    mainFile: fs.existsSync(mainPath) ? mainPath : undefined,
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
    selectedToolCountMin: selectedToolCounts.length ? Math.min(...selectedToolCounts) : undefined,
    selectedToolCountMax: selectedToolCounts.length ? Math.max(...selectedToolCounts) : undefined,
  };
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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
      gateFailures: ["summary_parse_error"],
    };
  }

  const artifact = parsed.value;
  const totals = artifact?.debugSummary?.totals ?? {};
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
    gateFailures,
  };
}

function printHistory(limit) {
  const summaryFiles = fs.readdirSync(outDir)
    .filter((file) => /^\d{8}-\d{6}-summary\.json$/.test(file))
    .sort();

  if (summaryFiles.length === 0) {
    console.error(`xtalpi-pi-tools debug summary: no *-summary.json files found in ${outDir}`);
    process.exit(1);
  }

  const selectedFiles = summaryFiles.slice(-limit).reverse();
  const runs = selectedFiles.map(summarizeSmokeSummaryFile);
  const parseErrorCount = runs.filter((run) => run.parseError).length;
  const history = {
    schema: "xtalpi-pi-tools.smoke-history.v1",
    outDir,
    requested: limit,
    totalArtifacts: summaryFiles.length,
    found: runs.length,
    order: "newest_first",
    parseErrorCount,
    runs,
  };

  if (format === "json") {
    console.log(JSON.stringify(history, null, 2));
  } else {
    console.log("xtalpi-pi-tools smoke history");
    console.log(
      `out_dir=${outDir} requested=${limit} found=${runs.length} total_artifacts=${summaryFiles.length} ` +
        "order=newest_first",
    );
    for (const run of runs) {
      const parseText = run.parseError ? ` parse_error=${JSON.stringify(run.parseError)}` : "";
      const gateText = run.gateFailures?.length ? ` gate_failures=${JSON.stringify(run.gateFailures)}` : "";
      const providerText = run.provider ? ` provider=${run.provider}` : "";
      const modelText = run.model ? ` model=${run.model}` : "";
      console.log(
        `- ${run.runId}: ok=${run.ok} failures=${run.failures} cases=${run.cases} ` +
          `recoveries=${run.recoveries} recovery_rate=${run.recoveryRate.toFixed(4)} ` +
          `raw_tool_markup_final_answers=${run.rawToolMarkupFinalAnswers} ` +
          `empty_assistant_ends=${run.emptyAssistantEnds} ` +
          `tool_envelope_final_answers=${run.toolEnvelopeFinalAnswers} ` +
          `errors=${run.errors} debug_summary_status=${run.debugSummaryStatus}` +
          `${providerText}${modelText}${gateText}${parseText}`,
      );
    }
  }

  process.exit(parseErrorCount > 0 ? 1 : 0);
}

if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
  console.error(`xtalpi-pi-tools debug summary: directory not found: ${outDir}`);
  process.exit(1);
}

if (historyLimit !== undefined) {
  printHistory(historyLimit);
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
  for (const [event, count] of Object.entries(item.recoveryByEvent)) {
    increment(totals.recoveryByEvent, event, count);
  }
}

totals.recoveryRate = totals.turns > 0 ? totals.recoveries / totals.turns : 0;

const gateFailures = [];
if (gates.expectCases !== undefined && totals.cases !== gates.expectCases) {
  gateFailures.push(`expected cases=${gates.expectCases}, got ${totals.cases}`);
}
if (gates.maxErrors !== undefined && totals.errors > gates.maxErrors) {
  gateFailures.push(`expected errors<=${gates.maxErrors}, got ${totals.errors}`);
}
if (totals.debugParseErrors > 0 || totals.mainParseErrors > 0) {
  gateFailures.push(`expected parse_errors=0, got debug=${totals.debugParseErrors} main=${totals.mainParseErrors}`);
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
      `pi_tool_starts=${totals.piToolStarts} errors=${totals.errors}`,
  );
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
    console.log(
      `- ${item.runId}/${item.caseName}: debug_events=${item.debugEvents} turns=${item.turns} tool_calls=${item.toolCalls}` +
        ` recoveries=${item.recoveries} empty_assistant_ends=${item.emptyAssistantEnds}` +
        ` raw_tool_markup_final_answer=${item.rawToolMarkupFinalAnswer}` +
        ` tool_envelope_final_answer=${item.toolEnvelopeFinalAnswer}${recoveryText}${toolText}${selectedText}` +
        ` final_text_chars=${item.finalTextChars}`,
    );
  }
  if (gateFailures.length > 0) {
    console.error(`gate_failures=${JSON.stringify(gateFailures)}`);
  }
}

process.exit(gateFailures.length > 0 ? 1 : 0);
NODE
