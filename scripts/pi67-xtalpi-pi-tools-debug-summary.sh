#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
FORMAT="text"
LATEST_ONLY="0"
RUN_ID=""
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

if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
  console.error(`xtalpi-pi-tools debug summary: directory not found: ${outDir}`);
  process.exit(1);
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
