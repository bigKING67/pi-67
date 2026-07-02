#!/usr/bin/env bash
set -u

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

  node - "$file" "$stderr_file" "$status" "$expected_tools" <<'NODE'
const fs = require("fs");
const [file, stderrFile, status, expectedToolsRaw] = process.argv.slice(2);
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, "utf8").trim() : "";
const events = text
  ? text.split(/\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "parse_error", raw: line.slice(0, 200) };
      }
    })
  : [];
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
const recoveries = events.filter((event) => JSON.stringify(event).includes("xtalpi-pi-tools")).length;
const processExitedCleanly = Number(status) === 0;
const hasUsableFinalAnswer = !!agent && errors.length === 0 && finalText.trim().length > 0;
const expectedTools = String(expectedToolsRaw || "any")
  .split(",")
  .map((tool) => tool.trim())
  .filter(Boolean);
let toolExpectationOk = true;
let toolExpectation = "any";
if (expectedTools.length === 1 && expectedTools[0] === "none") {
  toolExpectation = "none";
  toolExpectationOk = actualToolNames.length === 0;
} else if (expectedTools.length > 0 && expectedTools[0] !== "any") {
  toolExpectation = expectedTools.join(",");
  toolExpectationOk = expectedTools.some((tool) => actualToolNames.includes(tool));
}
const ok = processExitedCleanly && hasUsableFinalAnswer && toolExpectationOk;
console.log(JSON.stringify({
  file,
  ok,
  exitStatus: Number(status),
  processExitedCleanly,
  hasAgentEnd: !!agent,
  expectedTools: toolExpectation,
  toolExpectationOk,
  toolStarts,
  errors,
  stderr: stderr.slice(0, 500),
  emptyAssistantEnds,
  recoveries,
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
  local status=0
  local elapsed=0
  local pid

  "$PI_BIN" "${COMMON_ARGS[@]}" "$@" -p "$prompt" >"$out" 2>"$err" &
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
  summarize_jsonl "$out" "$err" "$status" "$expected_tools" || return 1
}

failures=0

run_case "no-tool" "请不要调用工具，只用一句中文回复：xtalpi pi tools smoke ok。" "none" --no-tools || failures=$((failures + 1))

run_case "bash" "请只执行一次 pwd，然后用一句中文总结结果。不要再调用第二个工具。" "bash" --tools bash || failures=$((failures + 1))

run_case "read" "请读取 $HOME/.pi/agent/package.json，然后用一句话说出包名和版本。" "read" --tools read || failures=$((failures + 1))

run_case "web-read" "请检查 https://github.com/ff-labs/pi-fff 是否能访问；如果是 404，请读取 $HOME/.pi/agent/npm/node_modules/@ff-labs/pi-fff/README.md 和 package.json，用三句话总结结论。不要搜索本机目录。" "fetch_content,web_fetch,read" || failures=$((failures + 1))

echo "===== summary ====="
echo "provider=$PROVIDER model=$MODEL out_dir=$OUT_DIR stamp=$STAMP case_timeout_seconds=$CASE_TIMEOUT_SECONDS failures=$failures"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
