#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
FORMAT="text"
LATEST_ONLY="0"
EXPECT_CASES=""
MAX_ERRORS="0"
MAX_EMPTY_ASSISTANT_ENDS=""
MAX_RECOVERIES=""
MAX_RECOVERY_RATE=""

usage() {
  cat <<'EOF'
Usage: pi67-xtalpi-pi-tools-debug-summary.sh [--json] [--latest] [options] [OUT_DIR]

Summarize xtalpi-pi-tools live smoke artifacts:
  - *.debug.jsonl provider telemetry
  - matching *.jsonl Pi event streams, when present

Gate options:
  --expect-cases N
  --max-errors N                  default: 0
  --max-empty-assistant-ends N
  --max-recoveries N
  --max-recovery-rate N           recoveries / turns

Default OUT_DIR:
  $HOME/tmp/xtalpi-pi-tools-smoke
EOF
}

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
  "$EXPECT_CASES" \
  "$MAX_ERRORS" \
  "$MAX_EMPTY_ASSISTANT_ENDS" \
  "$MAX_RECOVERIES" \
  "$MAX_RECOVERY_RATE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [
  outDir,
  format,
  latestOnlyRaw,
  expectCasesRaw,
  maxErrorsRaw,
  maxEmptyAssistantEndsRaw,
  maxRecoveriesRaw,
  maxRecoveryRateRaw,
] = process.argv.slice(2);
const latestOnly = latestOnlyRaw === "1";

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

if (latestOnly) {
  const runIds = debugFiles
    .map((file) => file.match(/^(\d{8}-\d{6})-/)?.[1])
    .filter(Boolean)
    .sort();
  const latestRunId = runIds.at(-1);
  if (latestRunId) {
    debugFiles = debugFiles.filter((file) => file.startsWith(`${latestRunId}-`));
  }
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
if (gates.maxRecoveries !== undefined && totals.recoveries > gates.maxRecoveries) {
  gateFailures.push(`expected recoveries<=${gates.maxRecoveries}, got ${totals.recoveries}`);
}
if (gates.maxRecoveryRate !== undefined && totals.recoveryRate > gates.maxRecoveryRate) {
  gateFailures.push(`expected recovery_rate<=${gates.maxRecoveryRate}, got ${totals.recoveryRate.toFixed(4)}`);
}

const summary = { outDir, latestOnly, gates, gateFailures, totals, cases };

if (format === "json") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("xtalpi-pi-tools debug summary");
  console.log(`out_dir=${outDir} latest_only=${latestOnly}`);
  console.log(
    `cases=${totals.cases} debug_events=${totals.debugEvents} turns=${totals.turns} ` +
      `tool_calls=${totals.toolCalls} recoveries=${totals.recoveries} recovery_rate=${totals.recoveryRate.toFixed(4)} ` +
      `empty_assistant_ends=${totals.emptyAssistantEnds} pi_tool_starts=${totals.piToolStarts} errors=${totals.errors}`,
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
        ` recoveries=${item.recoveries} empty_assistant_ends=${item.emptyAssistantEnds}${recoveryText}${toolText}${selectedText}` +
        ` final_text_chars=${item.finalTextChars}`,
    );
  }
  if (gateFailures.length > 0) {
    console.error(`gate_failures=${JSON.stringify(gateFailures)}`);
  }
}

process.exit(gateFailures.length > 0 ? 1 : 0);
NODE
