#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_BIN="${PI_BIN:-$(which pi)}"
PROVIDER="${PROVIDER:-xtalpi-pi-tools}"
MODEL="${MODEL:-deepseek-v4-pro}"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
CASE_TIMEOUT_SECONDS="${CASE_TIMEOUT_SECONDS:-180}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY_FILE="${XTALPI_PI_TOOLS_SMOKE_SUMMARY_FILE:-$OUT_DIR/${STAMP}-summary.json}"
DEBUG_SUMMARY_JSON_FILE="$OUT_DIR/${STAMP}-debug-summary.json"

mkdir -p "$OUT_DIR"

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

summarize_jsonl() {
  local file="$1"
  local stderr_file="$2"
  local status="$3"
  local expected_tools="${4:-any}"
  local debug_file="${5:-}"

  node - "$file" "$stderr_file" "$status" "$expected_tools" "$debug_file" <<'NODE'
const fs = require("fs");
const [file, stderrFile, status, expectedToolsRaw, debugFile] = process.argv.slice(2);
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
const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, "utf8").trim() : "";
const events = readJsonl(file);
const debugEvents = readJsonl(debugFile);
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
const ok = processExitedCleanly && hasUsableFinalAnswer && toolExpectation.ok && debugTelemetryOk;
console.log(JSON.stringify({
  file,
  debugFile,
  ok,
  exitStatus: Number(status),
  processExitedCleanly,
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
NODE

  if ! output="$(summarize_jsonl "$tmp_dir/good.jsonl" "$tmp_dir/good.stderr" 0 "all:web_fetch,read;only:web_fetch,read" "$tmp_dir/good.debug.jsonl" 2>&1)"; then
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/unexpected-tool.jsonl" "$tmp_dir/unexpected-tool.stderr" 0 "all:web_fetch,read;only:web_fetch,read" "$tmp_dir/unexpected-tool.debug.jsonl" 2>&1)"; then
    echo "expected unexpected-tool fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/raw-markup.jsonl" "$tmp_dir/raw-markup.stderr" 0 "read" "$tmp_dir/raw-markup.debug.jsonl" 2>&1)"; then
    echo "expected raw-markup fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/malformed-markup.jsonl" "$tmp_dir/malformed-markup.stderr" 0 "read" "$tmp_dir/malformed-markup.debug.jsonl" 2>&1)"; then
    echo "expected malformed-markup fixture to fail"
    echo "$output"
    return 1
  fi

  if output="$(summarize_jsonl "$tmp_dir/neutral-history-record.jsonl" "$tmp_dir/neutral-history-record.stderr" 0 "read" "$tmp_dir/neutral-history-record.debug.jsonl" 2>&1)"; then
    echo "expected neutral-history-record fixture to fail"
    echo "$output"
    return 1
  fi

  echo "xtalpi-pi-tools smoke self-test passed"
}

if [ "${1:-}" = "--self-test" ]; then
  run_self_test
  exit 0
fi

run_case() {
  local name="$1"
  local prompt="$2"
  local expected_tools="$3"
  shift 3
  local out="$OUT_DIR/${STAMP}-${name}.jsonl"
  local err="$OUT_DIR/${STAMP}-${name}.stderr"
  local debug="$OUT_DIR/${STAMP}-${name}.debug.jsonl"
  local status=0
  local elapsed=0
  local pid

  XTALPI_PI_TOOLS_DEBUG=1 XTALPI_PI_TOOLS_DEBUG_PATH="$debug" "$PI_BIN" "${COMMON_ARGS[@]}" "$@" -p "$prompt" >"$out" 2>"$err" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$CASE_TIMEOUT_SECONDS" ]; then
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

  echo "===== $name ====="
  summarize_jsonl "$out" "$err" "$status" "$expected_tools" "$debug" || return 1
}

write_run_summary_artifact() {
  local debug_summary_status="$1"
  local failure_count="$2"

  node - "$DEBUG_SUMMARY_JSON_FILE" "$SUMMARY_FILE" "$PROVIDER" "$MODEL" "$STAMP" "$CASE_TIMEOUT_SECONDS" "$failure_count" "$debug_summary_status" <<'NODE'
const fs = require("fs");
const [
  debugSummaryFile,
  summaryFile,
  provider,
  model,
  stamp,
  caseTimeoutSecondsRaw,
  failuresRaw,
  debugSummaryStatusRaw,
] = process.argv.slice(2);

const debugSummary = JSON.parse(fs.readFileSync(debugSummaryFile, "utf8"));
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
  failures,
  debugSummaryStatus,
  ok: failures === 0 && debugSummaryStatus === 0 && Array.isArray(debugSummary.gateFailures) && debugSummary.gateFailures.length === 0,
  debugSummary,
};

fs.writeFileSync(summaryFile, `${JSON.stringify(artifact, null, 2)}\n`);
NODE
}

failures=0

run_case "no-tool" "请不要调用工具，只用一句中文回复：xtalpi pi tools smoke ok。" "none" --no-tools || failures=$((failures + 1))

run_case "bash" "请只执行一次 pwd，然后用一句中文总结结果。不要再调用第二个工具。" "bash" --tools bash || failures=$((failures + 1))

run_case "read" "请读取 $HOME/.pi/agent/package.json，然后用一句话说出包名和版本。" "read" --tools read || failures=$((failures + 1))

run_case "bash-read" "这是严格工具顺序 smoke：第一步必须使用 bash 工具且 command 必须是 pwd；第二步必须使用 read 工具读取 $HOME/.pi/agent/package.json。禁止用 bash 执行 cat/ls/grep/读取文件。最后用两句话分别说明当前目录、包名和版本。" "all:bash,read" --tools bash,read || failures=$((failures + 1))

run_case "web-read" "请使用 web_fetch 检查 https://github.com/ff-labs/pi-fff 是否能访问；无论 web_fetch 返回什么结果，都继续使用 read 读取 $HOME/.pi/agent/npm/node_modules/@ff-labs/pi-fff/package.json。最后用两句话总结访问结果和本地包名版本。不要搜索本机目录，不要读取 README.md。" "all:web_fetch,read;only:web_fetch,read" --tools web_fetch,read || failures=$((failures + 1))

if [ -x "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" ]; then
  echo "===== debug-summary ====="
  debug_summary_status=0
  "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" \
    --run-id "$STAMP" \
    --expect-cases 5 \
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
    --expect-cases 5 \
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
  elif ! write_run_summary_artifact "$debug_summary_json_status" "$failures"; then
    echo "xtalpi-pi-tools smoke: failed to write summary artifact: $SUMMARY_FILE" >&2
    failures=$((failures + 1))
  fi
fi

echo "===== summary ====="
echo "provider=$PROVIDER model=$MODEL out_dir=$OUT_DIR stamp=$STAMP case_timeout_seconds=$CASE_TIMEOUT_SECONDS failures=$failures"
if [ -f "$SUMMARY_FILE" ]; then
  echo "summary_json=$SUMMARY_FILE"
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi
