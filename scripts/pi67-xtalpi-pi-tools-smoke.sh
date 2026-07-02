#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_BIN="${PI_BIN:-$(which pi)}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
PROVIDER="${PROVIDER:-xtalpi-pi-tools}"
MODEL="${MODEL:-deepseek-v4-pro}"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
CASE_TIMEOUT_SECONDS="${CASE_TIMEOUT_SECONDS:-240}"
SMOKE_REQUEST_TIMEOUT_MS="${XTALPI_PI_TOOLS_SMOKE_REQUEST_TIMEOUT_MS:-${XTALPI_PI_TOOLS_TIMEOUT_MS:-180000}}"
SMOKE_MAX_OUTPUT_TOKENS="${XTALPI_PI_TOOLS_SMOKE_MAX_OUTPUT_TOKENS:-${XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS:-1024}}"
SMOKE_STOP_ON_PROVIDER_ERROR="${XTALPI_PI_TOOLS_SMOKE_STOP_ON_PROVIDER_ERROR:-1}"
SMOKE_PREFLIGHT="${XTALPI_PI_TOOLS_SMOKE_PREFLIGHT:-1}"
SMOKE_PREFLIGHT_TIMEOUT_MS="${XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_TIMEOUT_MS:-30000}"
SMOKE_PREFLIGHT_ATTEMPTS="${XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_ATTEMPTS:-2}"
SMOKE_PREFLIGHT_RETRY_DELAY_MS="${XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_RETRY_DELAY_MS:-1000}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY_FILE="${XTALPI_PI_TOOLS_SMOKE_SUMMARY_FILE:-$OUT_DIR/${STAMP}-summary.json}"
DEBUG_SUMMARY_JSON_FILE="$OUT_DIR/${STAMP}-debug-summary.json"
PROVIDER_HEALTH_FILE="$OUT_DIR/${STAMP}-provider-health.json"

COMMON_ARGS=(
  --provider "$PROVIDER"
  --model "$MODEL"
  --thinking off
  --no-session
  --no-context-files
  --no-skills
  --no-prompt-templates
  --no-themes
  --mode json
)

AVAILABLE_CASES=(no-tool bash read bash-read web-read)
REQUESTED_CASES=()
SELECTED_CASES=()
EXPECTED_CASES=0
REQUESTED_CASE_FILTER_ACTIVE=0
RUN_SELF_TEST=0
STOP_REMAINING=0
STOP_REASON=""
LAST_CASE_PROVIDER_ERRORS=0

print_usage() {
  cat <<'EOF'
Usage:
  pi67-xtalpi-pi-tools-smoke.sh [--case NAME[,NAME...]]...
  pi67-xtalpi-pi-tools-smoke.sh --list-cases
  pi67-xtalpi-pi-tools-smoke.sh --self-test

Environment:
  CASE_TIMEOUT_SECONDS                         Per-case watchdog seconds. Default: 240.
  XTALPI_PI_TOOLS_SMOKE_REQUEST_TIMEOUT_MS     Provider request timeout for smoke child processes. Default: 180000.
  XTALPI_PI_TOOLS_SMOKE_MAX_OUTPUT_TOKENS      Provider max output tokens for smoke child processes. Default: 1024.
  XTALPI_PI_TOOLS_SMOKE_STOP_ON_PROVIDER_ERROR Stop remaining cases after a provider error. Default: 1.
  XTALPI_PI_TOOLS_SMOKE_PREFLIGHT              Run provider health preflight before cases. Default: 1.
  XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_TIMEOUT_MS   Provider health preflight timeout. Default: 30000.
  XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_ATTEMPTS     Provider health preflight attempts. Default: 2.
  XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_RETRY_DELAY_MS Delay between preflight retryable attempts. Default: 1000.
  XTALPI_PI_TOOLS_SMOKE_CASES                  Comma-separated case filter, same values as --case.
EOF
}

print_cases() {
  printf '%s\n' "${AVAILABLE_CASES[@]}"
}

case_name_is_valid() {
  case "$1" in
    no-tool | bash | read | bash-read | web-read) return 0 ;;
    *) return 1 ;;
  esac
}

case_filter_contains() {
  local needle="$1"
  local existing
  for existing in "${REQUESTED_CASES[@]+"${REQUESTED_CASES[@]}"}"; do
    if [ "$existing" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

add_case_filter() {
  local raw="$1"
  local old_ifs
  local part

  if [ -z "$raw" ]; then
    echo "--case requires a non-empty case name" >&2
    return 1
  fi

  old_ifs="$IFS"
  IFS=","
  set -- $raw
  IFS="$old_ifs"

  for part in "$@"; do
    if ! case_name_is_valid "$part"; then
      echo "unknown xtalpi-pi-tools smoke case: $part" >&2
      echo "available cases: ${AVAILABLE_CASES[*]}" >&2
      return 1
    fi
    if ! case_filter_contains "$part"; then
      REQUESTED_CASES+=("$part")
    fi
    REQUESTED_CASE_FILTER_ACTIVE=1
  done
}

case_is_requested() {
  local name="$1"
  if [ "$REQUESTED_CASE_FILTER_ACTIVE" -eq 0 ]; then
    return 0
  fi
  case_filter_contains "$name"
}

join_by_comma() {
  local IFS=","
  echo "$*"
}

flag_enabled() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

provider_error_count() {
  local debug_file="$1"
  node - "$debug_file" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log(0);
  process.exit(0);
}
let count = 0;
for (const line of fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean)) {
  try {
    const event = JSON.parse(line);
    if (event && event.event === "error.provider") count += 1;
  } catch {
    // The debug summary gate remains authoritative for parse errors.
  }
}
console.log(count);
NODE
}

run_provider_preflight() {
  node "$SCRIPT_DIR/pi67-xtalpi-provider-health.mjs" \
    --agent-dir "$PI_AGENT_DIR" \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    --timeout-ms "$SMOKE_PREFLIGHT_TIMEOUT_MS" \
    --attempts "$SMOKE_PREFLIGHT_ATTEMPTS" \
    --retry-delay-ms "$SMOKE_PREFLIGHT_RETRY_DELAY_MS" \
    --output-file "$PROVIDER_HEALTH_FILE"
}

summarize_jsonl() {
  local file="$1"
  local stderr_file="$2"
  local status="$3"
  local expected_tools="${4:-any}"
  local debug_file="${5:-}"
  local lifecycle_file="${6:-}"

  node - "$file" "$stderr_file" "$status" "$expected_tools" "$debug_file" "$lifecycle_file" <<'NODE'
const fs = require("fs");
const [file, stderrFile, status, expectedToolsRaw, debugFile, lifecycleFile] = process.argv.slice(2);
function readJsonl(path) {
  const raw = path && fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim() : "";
  if (!raw) return [];
  return raw.split(/\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: "parse_error", raw: line.slice(0, 200) };
    }
  });
}
function readJsonFile(path) {
  if (!path || !fs.existsSync(path)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, "utf8").trim() : "";
const events = readJsonl(file);
const debugEvents = readJsonl(debugFile);
const lifecycle = readJsonFile(lifecycleFile);
const debugTelemetryOk =
  debugEvents.length > 0 &&
  debugEvents.every(
    (event) =>
      event.schema === "xtalpi-pi-tools.debug.v1" &&
      typeof event.event === "string" &&
      typeof event.event_category === "string",
  );
const recoveryEvents = debugEvents.filter((event) => event.event_category === "recovery");
const agent = events.findLast?.((event) => event.type === "agent_end");
const toolStartEvents = events.filter((event) => event.type === "tool_execution_start");
const actualToolNames = toolStartEvents.map((event) => String(event.toolName || ""));
const toolStarts = toolStartEvents.map((event) => `${event.toolName}:${JSON.stringify(event.args)}`);
const errors = events
  .filter((event) => event.type === "error" || event.message?.stopReason === "error" || event.message?.errorMessage)
  .map((event) => event.message?.errorMessage || event.error || event.message)
  .filter(Boolean);
const final = agent?.messages?.filter((message) => message.role === "assistant").at(-1);
const finalText = Array.isArray(final?.content)
  ? final.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
  : "";
function stripPiToolEnvelopes(text) {
  return String(text || "")
    .replace(/<pi_tool_call_history\b[^>]*>[\s\S]*?<\/pi_tool_call_history>/g, "")
    .replace(/<pi_tool_call\b[^>]*>[\s\S]*?<\/pi_tool_call>/g, "")
    .replace(/<pi_tool_result\b[^>]*>[\s\S]*?<\/pi_tool_result>/g, "")
    .trim();
}
function containsRawPiToolMarkup(text) {
  return /(?:<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[\/?previous_pi_tool_call\])/i.test(String(text || ""));
}
function isToolEnvelopeOnlyFinalAnswer(text) {
  const trimmed = String(text || "").trim();
  return containsRawPiToolMarkup(trimmed) && stripPiToolEnvelopes(trimmed).length === 0;
}
const emptyAssistantEnds = events.filter(
  (event) =>
    event.type === "message_end" &&
    event.message?.role === "assistant" &&
    Array.isArray(event.message.content) &&
    event.message.content.length === 0,
).length;
const recoveries = recoveryEvents.length;
const processExitedCleanly = Number(status) === 0;
const finalAnswerRawToolMarkup = containsRawPiToolMarkup(finalText);
const finalAnswerEnvelopeOnly = isToolEnvelopeOnlyFinalAnswer(finalText);
const finalAnswerQualityOk = finalText.trim().length > 0 && !finalAnswerRawToolMarkup;
const hasUsableFinalAnswer = !!agent && errors.length === 0 && finalAnswerQualityOk;
function parseToolList(raw) {
  return String(raw || "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}
function evaluateToolExpectation(rawExpectation, actualNames) {
  const raw = String(rawExpectation || "any").trim() || "any";
  if (raw === "any") return { ok: true, label: "any", mode: "any", unexpectedTools: [] };

  const clauses = raw.includes(";") ? raw.split(";") : [raw];
  const labels = [];
  const modes = [];
  const unexpectedTools = [];
  let ok = true;

  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause || clause === "any") {
      labels.push("any");
      modes.push("any");
      continue;
    }
    if (clause === "none") {
      labels.push("none");
      modes.push("none");
      ok = ok && actualNames.length === 0;
      continue;
    }
    if (clause.startsWith("all:")) {
      const requiredTools = parseToolList(clause.slice("all:".length));
      labels.push(`all:${requiredTools.join(",")}`);
      modes.push("all");
      ok = ok && requiredTools.every((tool) => actualNames.includes(tool));
      continue;
    }
    if (clause.startsWith("any:")) {
      const allowedTools = parseToolList(clause.slice("any:".length));
      labels.push(`any:${allowedTools.join(",")}`);
      modes.push("any");
      ok = ok && allowedTools.some((tool) => actualNames.includes(tool));
      continue;
    }
    if (clause.startsWith("only:")) {
      const allowedTools = new Set(parseToolList(clause.slice("only:".length)));
      const extras = actualNames.filter((tool) => !allowedTools.has(tool));
      labels.push(`only:${[...allowedTools].join(",")}`);
      modes.push("only");
      for (const tool of extras) {
        if (!unexpectedTools.includes(tool)) unexpectedTools.push(tool);
      }
      ok = ok && extras.length === 0;
      continue;
    }

    const legacyAnyTools = parseToolList(clause);
    labels.push(legacyAnyTools.join(","));
    modes.push("any");
    ok = ok && legacyAnyTools.some((tool) => actualNames.includes(tool));
  }

  return { ok, label: labels.join(";"), mode: modes.join("+"), unexpectedTools };
}
const toolExpectation = evaluateToolExpectation(expectedToolsRaw, actualToolNames);
const elapsedSeconds = optionalNumber(lifecycle.elapsedSeconds);
const agentEndElapsedSeconds = optionalNumber(lifecycle.agentEndElapsedSeconds);
const postAgentEndLingerSeconds =
  elapsedSeconds !== undefined && agentEndElapsedSeconds !== undefined
    ? Math.max(0, elapsedSeconds - agentEndElapsedSeconds)
    : undefined;
const timedOutByWatchdog = lifecycle.timedOutByWatchdog === true;
const processLifecycleOk = processExitedCleanly;
const protocolFlowOk = hasUsableFinalAnswer && toolExpectation.ok;
const semanticFlowOk = protocolFlowOk && debugTelemetryOk;
const timedOutAfterAgentEnd = timedOutByWatchdog && !!agent;
const ok = processLifecycleOk && semanticFlowOk;
console.log(JSON.stringify({
  file,
  debugFile,
  lifecycleFile: lifecycleFile || undefined,
  ok,
  exitStatus: Number(status),
  processExitedCleanly,
  processLifecycleOk,
  timedOutByWatchdog,
  timedOutAfterAgentEnd,
  semanticFlowOk,
  protocolFlowOk,
  elapsedSeconds,
  agentEndElapsedSeconds,
  postAgentEndLingerSeconds,
  hasAgentEnd: !!agent,
  debugTelemetryOk,
  debugEventCount: debugEvents.length,
  expectedTools: toolExpectation.label,
  expectationMode: toolExpectation.mode,
  toolExpectationOk: toolExpectation.ok,
  unexpectedTools: toolExpectation.unexpectedTools,
  toolStarts,
  errors,
  stderr: stderr.slice(0, 500),
  finalAnswerQualityOk,
  finalAnswerRawToolMarkup,
  finalAnswerEnvelopeOnly,
  emptyAssistantEnds,
  recoveries,
  recoveryEvents: recoveryEvents.map((event) => ({
    event: event.event,
    eventKind: event.event_kind,
    toolName: event.tool_name,
    repairRetries: event.repair_retries,
    totalRecoveries: event.total_recoveries,
    selectedToolCount: event.selected_tool_count,
  })),
  finalStop: final?.stopReason,
  finalText: finalText.slice(0, 500),
}, null, 2));
process.exit(ok ? 0 : 1);
NODE
}

run_self_test() {
  local tmp_dir
  local output
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi67-xtalpi-smoke-self-test.XXXXXX")"
  trap "rm -rf '$tmp_dir'" EXIT

  node - "$tmp_dir" <<'NODE'
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];

function writeJsonl(file, events) {
  fs.writeFileSync(path.join(dir, file), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function writeFixture(name, { tools = [], finalText = "final answer", debugEvents = [] }) {
  writeJsonl(`${name}.jsonl`, [
    ...tools.map((toolName) => ({ type: "tool_execution_start", toolName, args: {} })),
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
  writeJsonl(`${name}.debug.jsonl`, debugEvents.length ? debugEvents : [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "turn.start",
      event_category: "turn",
      selected_tool_count: tools.length,
    },
  ]);
  fs.writeFileSync(path.join(dir, `${name}.stderr`), "");
  fs.writeFileSync(path.join(dir, `${name}.lifecycle.json`), `${JSON.stringify({
    schema: "xtalpi-pi-tools.smoke-lifecycle.v1",
    caseName: name,
    exitStatus: 0,
    elapsedSeconds: 1,
    caseTimeoutSeconds: 30,
    timedOutByWatchdog: false,
    agentEndSeenDuringRun: true,
    agentEndElapsedSeconds: 1,
    postAgentEndLingerSeconds: 0,
  }, null, 2)}\n`);
}

writeFixture("good", { tools: ["web_fetch", "read"], finalText: "normal final answer" });
writeFixture("unexpected-tool", { tools: ["web_fetch", "mcp", "read"], finalText: "normal final answer" });
writeFixture("raw-markup", {
  tools: ["read"],
  finalText: "<pi_tool_call_history>\nid: call_1\nname: read\n</pi_tool_call_history>",
});
writeFixture("malformed-markup", {
  tools: ["read"],
  finalText: "<pi_tool_call name=\"read\"\n{\"path\":\"package.json\"}",
});
writeFixture("neutral-history-record", {
  tools: ["read"],
  finalText: "[previous_pi_tool_call]\nid: call_1\nname: read\narguments_json: {\"path\":\"package.json\"}\n[/previous_pi_tool_call]",
});
writeFixture("provider-error", {
  finalText: "provider failed",
  debugEvents: [
    {
      schema: "xtalpi-pi-tools.debug.v1",
      event: "error.provider",
      event_category: "error",
      event_kind: "provider",
      error_code: "network_error",
      error_category: "network",
      retryable: true,
    },
  ],
});
NODE

  if ! output="$(summarize_jsonl "$tmp_dir/good.jsonl" "$tmp_dir/good.stderr" 0 "all:web_fetch,read;only:web_fetch,read" "$tmp_dir/good.debug.jsonl" "$tmp_dir/good.lifecycle.json" 2>&1)"; then
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/unexpected-tool.jsonl" "$tmp_dir/unexpected-tool.stderr" 0 "all:web_fetch,read;only:web_fetch,read" "$tmp_dir/unexpected-tool.debug.jsonl" "$tmp_dir/unexpected-tool.lifecycle.json" 2>&1)"; then
    echo "expected unexpected-tool fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/raw-markup.jsonl" "$tmp_dir/raw-markup.stderr" 0 "read" "$tmp_dir/raw-markup.debug.jsonl" "$tmp_dir/raw-markup.lifecycle.json" 2>&1)"; then
    echo "expected raw-markup fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/malformed-markup.jsonl" "$tmp_dir/malformed-markup.stderr" 0 "read" "$tmp_dir/malformed-markup.debug.jsonl" "$tmp_dir/malformed-markup.lifecycle.json" 2>&1)"; then
    echo "expected malformed-markup fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/neutral-history-record.jsonl" "$tmp_dir/neutral-history-record.stderr" 0 "read" "$tmp_dir/neutral-history-record.debug.jsonl" "$tmp_dir/neutral-history-record.lifecycle.json" 2>&1)"; then
    echo "expected neutral-history-record fixture to fail"
    echo "$output"
    return 1
  fi
  if [ "$(provider_error_count "$tmp_dir/provider-error.debug.jsonl")" -ne 1 ]; then
    echo "provider error counter did not detect the provider-error fixture"
    return 1
  fi

  node - "$tmp_dir/good.lifecycle.json" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const lifecycle = JSON.parse(fs.readFileSync(file, "utf8"));
lifecycle.exitStatus = 124;
lifecycle.elapsedSeconds = 42;
lifecycle.caseTimeoutSeconds = 40;
lifecycle.timedOutByWatchdog = true;
lifecycle.agentEndSeenDuringRun = true;
lifecycle.agentEndElapsedSeconds = 12;
lifecycle.postAgentEndLingerSeconds = 30;
fs.writeFileSync(file, `${JSON.stringify(lifecycle, null, 2)}\n`);
NODE
  if output="$(summarize_jsonl "$tmp_dir/good.jsonl" "$tmp_dir/good.stderr" 124 "all:web_fetch,read;only:web_fetch,read" "$tmp_dir/good.debug.jsonl" "$tmp_dir/good.lifecycle.json" 2>&1)"; then
    echo "expected timed-out-after-agent-end fixture to fail process lifecycle"
    echo "$output"
    return 1
  fi
  if ! printf '%s\n' "$output" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
if (data.semanticFlowOk !== true) throw new Error("semanticFlowOk should remain true");
if (data.processLifecycleOk !== false) throw new Error("processLifecycleOk should be false");
if (data.timedOutAfterAgentEnd !== true) throw new Error("timedOutAfterAgentEnd should be true");
if (data.postAgentEndLingerSeconds !== 30) throw new Error("unexpected postAgentEndLingerSeconds");
'; then
    echo "$output"
    return 1
  fi

  REQUESTED_CASES=()
  REQUESTED_CASE_FILTER_ACTIVE=0
  if ! add_case_filter "no-tool,web-read"; then
    echo "expected comma-separated case filter to parse"
    return 1
  fi
  if ! case_is_requested "no-tool" || ! case_is_requested "web-read" || case_is_requested "bash"; then
    echo "case filter selection did not match expected cases"
    return 1
  fi
  if add_case_filter "not-a-case" 2>/dev/null; then
    echo "expected invalid case filter to fail"
    return 1
  fi
  REQUESTED_CASES=()
  REQUESTED_CASE_FILTER_ACTIVE=0

  echo "xtalpi-pi-tools smoke self-test passed"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test)
      RUN_SELF_TEST=1
      shift
      ;;
    --case)
      shift
      if ! add_case_filter "${1:-}"; then
        exit 2
      fi
      shift
      ;;
    --case=*)
      if ! add_case_filter "${1#--case=}"; then
        exit 2
      fi
      shift
      ;;
    --list-cases)
      print_cases
      exit 0
      ;;
    -h | --help)
      print_usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

if [ "$RUN_SELF_TEST" -eq 1 ]; then
  run_self_test
  exit 0
fi

if [ -n "${XTALPI_PI_TOOLS_SMOKE_CASES:-}" ]; then
  if ! add_case_filter "$XTALPI_PI_TOOLS_SMOKE_CASES"; then
    exit 2
  fi
fi

mkdir -p "$OUT_DIR"

run_case() {
  local name="$1"
  local prompt="$2"
  local expected_tools="$3"
  shift 3
  local out="$OUT_DIR/${STAMP}-${name}.jsonl"
  local err="$OUT_DIR/${STAMP}-${name}.stderr"
  local debug="$OUT_DIR/${STAMP}-${name}.debug.jsonl"
  local lifecycle="$OUT_DIR/${STAMP}-${name}.lifecycle.json"
  local status=0
  local elapsed=0
  local elapsed_seconds=0
  local start_epoch=0
  local end_epoch=0
  local timed_out_by_watchdog=0
  local agent_end_seen=0
  local agent_end_elapsed=""
  local pid

  start_epoch="$(date +%s)"
  XTALPI_PI_TOOLS_TIMEOUT_MS="$SMOKE_REQUEST_TIMEOUT_MS" XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS="$SMOKE_MAX_OUTPUT_TOKENS" XTALPI_PI_TOOLS_DEBUG=1 XTALPI_PI_TOOLS_DEBUG_PATH="$debug" "$PI_BIN" "${COMMON_ARGS[@]}" "$@" -p "$prompt" >"$out" 2>"$err" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$agent_end_seen" -eq 0 ] && [ -f "$out" ] && grep -q '"type":"agent_end"' "$out" 2>/dev/null; then
      agent_end_seen=1
      agent_end_elapsed="$elapsed"
    fi
    if [ "$elapsed" -ge "$CASE_TIMEOUT_SECONDS" ]; then
      timed_out_by_watchdog=1
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
      status=124
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if [ "$status" -eq 0 ]; then
    wait "$pid" || status=$?
  else
    wait "$pid" 2>/dev/null || true
  fi
  if [ "$agent_end_seen" -eq 0 ] && [ -f "$out" ] && grep -q '"type":"agent_end"' "$out" 2>/dev/null; then
    agent_end_seen=1
    agent_end_elapsed="$elapsed"
  fi
  end_epoch="$(date +%s)"
  elapsed_seconds=$((end_epoch - start_epoch))
  node - "$lifecycle" "$name" "$status" "$elapsed_seconds" "$CASE_TIMEOUT_SECONDS" "$timed_out_by_watchdog" "$agent_end_seen" "$agent_end_elapsed" <<'NODE'
const fs = require("fs");
const [
  file,
  caseName,
  exitStatusRaw,
  elapsedSecondsRaw,
  caseTimeoutSecondsRaw,
  timedOutByWatchdogRaw,
  agentEndSeenRaw,
  agentEndElapsedSecondsRaw,
] = process.argv.slice(2);
const optionalNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};
const artifact = {
  schema: "xtalpi-pi-tools.smoke-lifecycle.v1",
  caseName,
  exitStatus: Number(exitStatusRaw),
  elapsedSeconds: Number(elapsedSecondsRaw),
  caseTimeoutSeconds: Number(caseTimeoutSecondsRaw),
  timedOutByWatchdog: timedOutByWatchdogRaw === "1",
  agentEndSeenDuringRun: agentEndSeenRaw === "1",
};
const agentEndElapsedSeconds = optionalNumber(agentEndElapsedSecondsRaw);
if (agentEndElapsedSeconds !== undefined) {
  artifact.agentEndElapsedSeconds = agentEndElapsedSeconds;
  artifact.postAgentEndLingerSeconds = Math.max(0, artifact.elapsedSeconds - agentEndElapsedSeconds);
}
fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
NODE

  echo "===== $name ====="
  local summary_status=0
  summarize_jsonl "$out" "$err" "$status" "$expected_tools" "$debug" "$lifecycle" || summary_status=$?
  LAST_CASE_PROVIDER_ERRORS="$(provider_error_count "$debug")"
  return "$summary_status"
}

run_selected_case() {
  local name="$1"
  shift
  if [ "$STOP_REMAINING" -eq 1 ]; then
    return 0
  fi
  if ! case_is_requested "$name"; then
    return 0
  fi
  SELECTED_CASES+=("$name")
  EXPECTED_CASES=$((EXPECTED_CASES + 1))
  local case_status=0
  run_case "$name" "$@" || case_status=$?
  if [ "$case_status" -ne 0 ] && flag_enabled "$SMOKE_STOP_ON_PROVIDER_ERROR" && [ "${LAST_CASE_PROVIDER_ERRORS:-0}" -gt 0 ]; then
    STOP_REMAINING=1
    STOP_REASON="provider_errors_after_${name}"
    echo "xtalpi-pi-tools smoke: stopping remaining cases after provider_errors=${LAST_CASE_PROVIDER_ERRORS} in case=$name (set XTALPI_PI_TOOLS_SMOKE_STOP_ON_PROVIDER_ERROR=0 to run all cases)" >&2
  fi
  return "$case_status"
}

write_run_summary_artifact() {
  local debug_summary_status="$1"
  local failure_count="$2"
  local selected_cases_csv="$3"
  local stop_reason="$4"

  node - "$DEBUG_SUMMARY_JSON_FILE" "$SUMMARY_FILE" "$PROVIDER_HEALTH_FILE" "$PROVIDER" "$MODEL" "$STAMP" "$CASE_TIMEOUT_SECONDS" "$SMOKE_REQUEST_TIMEOUT_MS" "$SMOKE_MAX_OUTPUT_TOKENS" "$selected_cases_csv" "$failure_count" "$debug_summary_status" "$SMOKE_STOP_ON_PROVIDER_ERROR" "$SMOKE_PREFLIGHT" "$SMOKE_PREFLIGHT_TIMEOUT_MS" "$SMOKE_PREFLIGHT_ATTEMPTS" "$SMOKE_PREFLIGHT_RETRY_DELAY_MS" "$stop_reason" <<'NODE'
const fs = require("fs");
const [
  debugSummaryFile,
  summaryFile,
  providerHealthFile,
  provider,
  model,
  stamp,
  caseTimeoutSecondsRaw,
  requestTimeoutMsRaw,
  maxOutputTokensRaw,
  selectedCasesRaw,
  failuresRaw,
  debugSummaryStatusRaw,
  stopOnProviderErrorRaw,
  preflightRaw,
  preflightTimeoutMsRaw,
  preflightAttemptsRaw,
  preflightRetryDelayMsRaw,
  stopReasonRaw,
] = process.argv.slice(2);

const debugSummary = JSON.parse(fs.readFileSync(debugSummaryFile, "utf8"));
const providerHealth = providerHealthFile && fs.existsSync(providerHealthFile)
  ? JSON.parse(fs.readFileSync(providerHealthFile, "utf8"))
  : undefined;
const failures = Number(failuresRaw);
const debugSummaryStatus = Number(debugSummaryStatusRaw);
const artifact = {
  schema: "xtalpi-pi-tools.smoke-summary.v1",
  createdAt: new Date().toISOString(),
  provider,
  model,
  stamp,
  runId: debugSummary.runId || stamp,
  outDir: debugSummary.outDir,
  caseTimeoutSeconds: Number(caseTimeoutSecondsRaw),
  requestTimeoutMs: Number(requestTimeoutMsRaw),
  maxOutputTokens: Number(maxOutputTokensRaw),
  selectedCases: String(selectedCasesRaw || "").split(",").filter(Boolean),
  stopOnProviderError: /^(1|true|yes|on)$/i.test(String(stopOnProviderErrorRaw || "")),
  providerHealthPreflight: /^(1|true|yes|on)$/i.test(String(preflightRaw || "")),
  providerHealthPreflightTimeoutMs: Number(preflightTimeoutMsRaw),
  providerHealthPreflightAttempts: Number(preflightAttemptsRaw),
  providerHealthPreflightRetryDelayMs: Number(preflightRetryDelayMsRaw),
  stopReason: stopReasonRaw || undefined,
  providerHealth,
  failures,
  debugSummaryStatus,
  ok: failures === 0 && debugSummaryStatus === 0 && Array.isArray(debugSummary.gateFailures) && debugSummary.gateFailures.length === 0,
  debugSummary,
};

fs.writeFileSync(summaryFile, `${JSON.stringify(artifact, null, 2)}\n`);
NODE
}

write_preflight_failure_summary_artifact() {
  local failure_count="$1"
  local stop_reason="$2"

  node - "$SUMMARY_FILE" "$PROVIDER_HEALTH_FILE" "$PROVIDER" "$MODEL" "$STAMP" "$CASE_TIMEOUT_SECONDS" "$SMOKE_REQUEST_TIMEOUT_MS" "$SMOKE_MAX_OUTPUT_TOKENS" "$failure_count" "$SMOKE_STOP_ON_PROVIDER_ERROR" "$SMOKE_PREFLIGHT" "$SMOKE_PREFLIGHT_TIMEOUT_MS" "$SMOKE_PREFLIGHT_ATTEMPTS" "$SMOKE_PREFLIGHT_RETRY_DELAY_MS" "$stop_reason" <<'NODE'
const fs = require("fs");
const [
  summaryFile,
  providerHealthFile,
  provider,
  model,
  stamp,
  caseTimeoutSecondsRaw,
  requestTimeoutMsRaw,
  maxOutputTokensRaw,
  failuresRaw,
  stopOnProviderErrorRaw,
  preflightRaw,
  preflightTimeoutMsRaw,
  preflightAttemptsRaw,
  preflightRetryDelayMsRaw,
  stopReasonRaw,
] = process.argv.slice(2);

const providerHealth = providerHealthFile && fs.existsSync(providerHealthFile)
  ? JSON.parse(fs.readFileSync(providerHealthFile, "utf8"))
  : { ok: false, errorCode: "provider_health_missing", errorCategory: "configuration", retryable: false };
const providerErrorCode = String(providerHealth.errorCode || "unknown_error");
const providerErrorCategory = String(providerHealth.errorCategory || "unknown");
const debugSummary = {
  outDir: require("path").dirname(summaryFile),
  latestOnly: false,
  runId: stamp,
  gates: {
    providerHealthPreflight: true,
  },
  gateFailures: [`provider_health_failed:${providerErrorCode}`],
  totals: {
    cases: 0,
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
    providerErrors: 1,
    retryableProviderErrors: providerHealth.retryable === true ? 1 : 0,
    providerErrorCodes: { [providerErrorCode]: 1 },
    providerErrorCategories: { [providerErrorCategory]: 1 },
    recoveryByEvent: {},
    recoveryRate: 0,
  },
  cases: [],
};

const artifact = {
  schema: "xtalpi-pi-tools.smoke-summary.v1",
  createdAt: new Date().toISOString(),
  provider,
  model,
  stamp,
  runId: stamp,
  outDir: debugSummary.outDir,
  caseTimeoutSeconds: Number(caseTimeoutSecondsRaw),
  requestTimeoutMs: Number(requestTimeoutMsRaw),
  maxOutputTokens: Number(maxOutputTokensRaw),
  selectedCases: [],
  stopOnProviderError: /^(1|true|yes|on)$/i.test(String(stopOnProviderErrorRaw || "")),
  providerHealthPreflight: /^(1|true|yes|on)$/i.test(String(preflightRaw || "")),
  providerHealthPreflightTimeoutMs: Number(preflightTimeoutMsRaw),
  providerHealthPreflightAttempts: Number(preflightAttemptsRaw),
  providerHealthPreflightRetryDelayMs: Number(preflightRetryDelayMsRaw),
  stopReason: stopReasonRaw || undefined,
  providerHealth,
  failures: Number(failuresRaw),
  debugSummaryStatus: 1,
  ok: false,
  debugSummary,
};

fs.writeFileSync(summaryFile, `${JSON.stringify(artifact, null, 2)}\n`);
NODE
}

failures=0

if flag_enabled "$SMOKE_PREFLIGHT"; then
  echo "===== provider-health ====="
  if ! run_provider_preflight; then
    failures=$((failures + 1))
    STOP_REMAINING=1
    STOP_REASON="provider_health_failed"
    if ! write_preflight_failure_summary_artifact "$failures" "$STOP_REASON"; then
      echo "xtalpi-pi-tools smoke: failed to write preflight failure summary artifact: $SUMMARY_FILE" >&2
      failures=$((failures + 1))
    fi
    echo "===== summary ====="
    echo "provider=$PROVIDER model=$MODEL out_dir=$OUT_DIR stamp=$STAMP selected_cases= case_timeout_seconds=$CASE_TIMEOUT_SECONDS request_timeout_ms=$SMOKE_REQUEST_TIMEOUT_MS max_output_tokens=$SMOKE_MAX_OUTPUT_TOKENS preflight=$SMOKE_PREFLIGHT preflight_timeout_ms=$SMOKE_PREFLIGHT_TIMEOUT_MS preflight_attempts=$SMOKE_PREFLIGHT_ATTEMPTS preflight_retry_delay_ms=$SMOKE_PREFLIGHT_RETRY_DELAY_MS stop_on_provider_error=$SMOKE_STOP_ON_PROVIDER_ERROR stop_reason=${STOP_REASON:-none} failures=$failures"
    if [ -f "$SUMMARY_FILE" ]; then
      echo "summary_json=$SUMMARY_FILE"
    fi
    exit 1
  fi
fi

run_selected_case "no-tool" "请不要调用工具，只用一句中文回复：xtalpi pi tools smoke ok。" "none" --no-tools || failures=$((failures + 1))

run_selected_case "bash" "请只执行一次 pwd，然后用一句中文总结结果。不要再调用第二个工具。" "bash" --tools bash || failures=$((failures + 1))

run_selected_case "read" "请读取 $HOME/.pi/agent/package.json，然后用一句话说出包名和版本。" "read" --tools read || failures=$((failures + 1))

run_selected_case "bash-read" "这是严格工具顺序 smoke：第一步必须使用 bash 工具且 command 必须是 pwd；第二步必须使用 read 工具读取 $HOME/.pi/agent/package.json。禁止用 bash 执行 cat/ls/grep/读取文件。最后用两句话分别说明当前目录、包名和版本。" "all:bash,read" --tools bash,read || failures=$((failures + 1))

run_selected_case "web-read" "请使用 web_fetch 检查 https://github.com/ff-labs/pi-fff 是否能访问；无论 web_fetch 返回什么结果，都继续使用 read 读取 $HOME/.pi/agent/npm/node_modules/@ff-labs/pi-fff/package.json。最后用两句话总结访问结果和本地包名版本。不要搜索本机目录，不要读取 README.md。" "all:web_fetch,read;only:web_fetch,read" --tools web_fetch,read || failures=$((failures + 1))

if [ "$EXPECTED_CASES" -eq 0 ]; then
  echo "xtalpi-pi-tools smoke: no cases selected" >&2
  exit 2
fi

SELECTED_CASES_CSV="$(join_by_comma "${SELECTED_CASES[@]}")"

if [ -x "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" ]; then
  echo "===== debug-summary ====="
  debug_summary_status=0
  "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" \
    --run-id "$STAMP" \
    --expect-cases "$EXPECTED_CASES" \
    --max-errors 0 \
    --max-empty-assistant-ends 0 \
    --max-raw-tool-markup-final-answers 0 \
    --max-recoveries 8 \
    "$OUT_DIR" || debug_summary_status=$?
  if [ "$debug_summary_status" -ne 0 ]; then
    failures=$((failures + 1))
  fi

  debug_summary_json_status=0
  "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" \
    --json \
    --run-id "$STAMP" \
    --expect-cases "$EXPECTED_CASES" \
    --max-errors 0 \
    --max-empty-assistant-ends 0 \
    --max-raw-tool-markup-final-answers 0 \
    --max-recoveries 8 \
    "$OUT_DIR" >"$DEBUG_SUMMARY_JSON_FILE" || debug_summary_json_status=$?
  if [ "$debug_summary_json_status" -ne 0 ] && [ "$debug_summary_status" -eq 0 ]; then
    failures=$((failures + 1))
  fi
  if [ ! -s "$DEBUG_SUMMARY_JSON_FILE" ]; then
    echo "xtalpi-pi-tools smoke: debug summary JSON artifact was not written: $DEBUG_SUMMARY_JSON_FILE" >&2
    failures=$((failures + 1))
  elif ! write_run_summary_artifact "$debug_summary_json_status" "$failures" "$SELECTED_CASES_CSV" "$STOP_REASON"; then
    echo "xtalpi-pi-tools smoke: failed to write summary artifact: $SUMMARY_FILE" >&2
    failures=$((failures + 1))
  fi
fi

echo "===== summary ====="
echo "provider=$PROVIDER model=$MODEL out_dir=$OUT_DIR stamp=$STAMP selected_cases=$SELECTED_CASES_CSV case_timeout_seconds=$CASE_TIMEOUT_SECONDS request_timeout_ms=$SMOKE_REQUEST_TIMEOUT_MS max_output_tokens=$SMOKE_MAX_OUTPUT_TOKENS preflight=$SMOKE_PREFLIGHT preflight_timeout_ms=$SMOKE_PREFLIGHT_TIMEOUT_MS preflight_attempts=$SMOKE_PREFLIGHT_ATTEMPTS preflight_retry_delay_ms=$SMOKE_PREFLIGHT_RETRY_DELAY_MS stop_on_provider_error=$SMOKE_STOP_ON_PROVIDER_ERROR stop_reason=${STOP_REASON:-none} failures=$failures"
if [ -f "$SUMMARY_FILE" ]; then
  echo "summary_json=$SUMMARY_FILE"
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi
