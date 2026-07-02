#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_BIN="${PI_BIN:-$(which pi)}"
PROVIDER="${PROVIDER:-xtalpi-pi-tools}"
MODEL="${MODEL:-deepseek-v4-pro}"
OUT_DIR="${OUT_DIR:-$HOME/tmp/xtalpi-pi-tools-smoke}"
CASE_TIMEOUT_SECONDS="${CASE_TIMEOUT_SECONDS:-180}"
STAMP="$(date +%Y%m%d-%H%M%S)"

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
const emptyAssistantEnds = events.filter(
  (event) =>
    event.type === "message_end" &&
    event.message?.role === "assistant" &&
    Array.isArray(event.message.content) &&
    event.message.content.length === 0,
).length;
const recoveries = recoveryEvents.length;
const processExitedCleanly = Number(status) === 0;
const hasUsableFinalAnswer = !!agent && errors.length === 0 && finalText.trim().length > 0;
const expectedTools = String(expectedToolsRaw || "any")
  .split(",")
  .map((tool) => tool.trim())
  .filter(Boolean);
let toolExpectationOk = true;
let toolExpectation = "any";
let expectationMode = "any";
if (expectedTools.length === 1 && expectedTools[0] === "none") {
  expectationMode = "none";
  toolExpectation = "none";
  toolExpectationOk = actualToolNames.length === 0;
} else if (expectedTools.length > 0 && expectedTools[0].startsWith("all:")) {
  expectationMode = "all";
  expectedTools[0] = expectedTools[0].slice("all:".length);
  const requiredTools = expectedTools.filter(Boolean);
  toolExpectation = `all:${requiredTools.join(",")}`;
  toolExpectationOk = requiredTools.every((tool) => actualToolNames.includes(tool));
} else if (expectedTools.length > 0 && expectedTools[0].startsWith("any:")) {
  expectationMode = "any";
  expectedTools[0] = expectedTools[0].slice("any:".length);
  const allowedTools = expectedTools.filter(Boolean);
  toolExpectation = `any:${allowedTools.join(",")}`;
  toolExpectationOk = allowedTools.some((tool) => actualToolNames.includes(tool));
} else if (expectedTools.length > 0 && expectedTools[0] !== "any") {
  toolExpectation = expectedTools.join(",");
  toolExpectationOk = expectedTools.some((tool) => actualToolNames.includes(tool));
}
const ok = processExitedCleanly && hasUsableFinalAnswer && toolExpectationOk && debugTelemetryOk;
console.log(JSON.stringify({
  file,
  debugFile,
  ok,
  exitStatus: Number(status),
  processExitedCleanly,
  hasAgentEnd: !!agent,
  debugTelemetryOk,
  debugEventCount: debugEvents.length,
  expectedTools: toolExpectation,
  expectationMode,
  toolExpectationOk,
  toolStarts,
  errors,
  stderr: stderr.slice(0, 500),
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

failures=0

run_case "no-tool" "请不要调用工具，只用一句中文回复：xtalpi pi tools smoke ok。" "none" --no-tools || failures=$((failures + 1))

run_case "bash" "请只执行一次 pwd，然后用一句中文总结结果。不要再调用第二个工具。" "bash" --tools bash || failures=$((failures + 1))

run_case "read" "请读取 $HOME/.pi/agent/package.json，然后用一句话说出包名和版本。" "read" --tools read || failures=$((failures + 1))

run_case "bash-read" "这是严格工具顺序 smoke：第一步必须使用 bash 工具且 command 必须是 pwd；第二步必须使用 read 工具读取 $HOME/.pi/agent/package.json。禁止用 bash 执行 cat/ls/grep/读取文件。最后用两句话分别说明当前目录、包名和版本。" "all:bash,read" --tools bash,read || failures=$((failures + 1))

run_case "web-read" "请检查 https://github.com/ff-labs/pi-fff 是否能访问；如果是 404，请读取 $HOME/.pi/agent/npm/node_modules/@ff-labs/pi-fff/README.md 和 package.json，用三句话总结结论。不要搜索本机目录。" "fetch_content,web_fetch,read" || failures=$((failures + 1))

if [ -x "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" ]; then
  echo "===== debug-summary ====="
  "$SCRIPT_DIR/pi67-xtalpi-pi-tools-debug-summary.sh" \
    --latest \
    --expect-cases 5 \
    --max-errors 0 \
    --max-empty-assistant-ends 0 \
    --max-recoveries 8 \
    "$OUT_DIR" || failures=$((failures + 1))
fi

echo "===== summary ====="
echo "provider=$PROVIDER model=$MODEL out_dir=$OUT_DIR stamp=$STAMP case_timeout_seconds=$CASE_TIMEOUT_SECONDS failures=$failures"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
