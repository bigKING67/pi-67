const crypto = require("node:crypto");
const fs = require("node:fs");

const FULL_SUITE_CASE_NAMES = [
  "no-tool",
  "bash",
  "read",
  "bash-read",
  "web-read",
  "plan-mode-contract",
  "tool-selection-clipping",
  "tool-selection-continuation",
  "until-done-continuation",
  "tool-result-injection",
];

function sortedUniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function buildCaseSet(values) {
  const selectedCases = (Array.isArray(values) ? values : []).map(String).filter(Boolean);
  const normalizedCases = sortedUniqueStrings(selectedCases);
  const canonical = normalizedCases.join(",");
  return {
    schema: "xtalpi-pi-tools.case-set.v1",
    selectedCases,
    normalizedCases,
    count: normalizedCases.length,
    canonical,
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
  };
}

function normalizeCaseSet(value, fallbackCases) {
  const fallback = buildCaseSet(fallbackCases);
  const raw = objectOrUndefined(value);
  if (!raw) return fallback;
  const normalizedCases = Array.isArray(raw.normalizedCases)
    ? sortedUniqueStrings(raw.normalizedCases)
    : fallback.normalizedCases;
  const canonical = normalizedCases.join(",");
  const sha256 = crypto.createHash("sha256").update(canonical).digest("hex");
  return {
    schema: typeof raw.schema === "string" ? raw.schema : "xtalpi-pi-tools.case-set.v1",
    selectedCases: Array.isArray(raw.selectedCases) ? raw.selectedCases.map(String).filter(Boolean) : fallback.selectedCases,
    normalizedCases,
    count: normalizedCases.length,
    canonical,
    sha256,
  };
}

function caseNameListsEqual(left, right) {
  const leftSorted = sortedUniqueStrings(left);
  const rightSorted = sortedUniqueStrings(right);
  return leftSorted.length === rightSorted.length &&
    leftSorted.every((item, index) => item === rightSorted[index]);
}

function classifyRunKind(caseSetOrCases, { providerHealth, stopReason } = {}) {
  const rawCaseSet = objectOrUndefined(caseSetOrCases);
  const normalizedCases = rawCaseSet
    ? sortedUniqueStrings(rawCaseSet.normalizedCases || rawCaseSet.selectedCases || [])
    : sortedUniqueStrings(caseSetOrCases);
  const providerHealthObject = objectOrUndefined(providerHealth);
  const reason = String(stopReason || "");

  if (
    reason === "provider_health_failed" ||
    (normalizedCases.length === 0 && providerHealthObject && providerHealthObject.ok === false)
  ) {
    return "preflight-failed";
  }
  if (caseNameListsEqual(normalizedCases, FULL_SUITE_CASE_NAMES)) return "full-suite";
  if (normalizedCases.length === 0) return "empty";
  return "targeted";
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

function readJsonlEvents(file, { parseErrorEvent = false, rawLimit = 200 } = {}) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return parseErrorEvent ? [{ type: "parse_error", raw: line.slice(0, rawLimit) }] : [];
    }
  });
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonFileAsObject(file) {
  if (!file || !fs.existsSync(file)) return {};
  const parsed = readJsonFile(file);
  return parsed.ok ? objectOrUndefined(parsed.value) || {} : {};
}

function stripPiToolEnvelopes(text) {
  return String(text || "")
    .replace(/<pi_tool_call_history\b[^>]*>[\s\S]*?<\/pi_tool_call_history>/g, "")
    .replace(/<pi_tool_call\b[^>]*>[\s\S]*?<\/pi_tool_call>/g, "")
    .replace(/<pi_tool_result\b[^>]*>[\s\S]*?<\/pi_tool_result>/g, "")
    .replace(/<previous_pi_tool_call\b[^>]*>[\s\S]*?<\/previous_pi_tool_call>/g, "")
    .trim();
}

function containsRawPiToolMarkup(text) {
  return /(?:<\/?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|<\/?previous_pi_tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[\/?previous_pi_tool_call\])/i.test(String(text || ""));
}

const TOOL_CALL_LIKE_NAMES = new Set([
  "bash",
  "batch_web_fetch",
  "bounded_read",
  "fetch_content",
  "fffind",
  "ffgrep",
  "find",
  "grep",
  "ls",
  "mcp",
  "read",
  "recall",
  "subagent",
  "until_done_block",
  "until_done_complete",
  "until_done_distill",
  "until_done_plan",
  "until_done_progress",
  "until_done_replan",
  "until_done_set",
  "until_done_task_update",
  "web_fetch",
  "web_search",
]);

function extractJsonArrayCandidates(text) {
  const source = String(text || "").slice(0, 12000);
  const candidates = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "[") {
        depth += 1;
        continue;
      }
      if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, index + 1));
          break;
        }
      }
    }
    if (candidates.length >= 8) break;
  }
  return candidates;
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolNameFromObject(value) {
  if (typeof value?.name === "string") return value.name.trim();
  if (typeof value?.tool === "string") return value.tool.trim();
  if (typeof value?.tool_name === "string") return value.tool_name.trim();
  if (objectOrUndefined(value?.function) && typeof value.function.name === "string") {
    return value.function.name.trim();
  }
  return undefined;
}

function argumentsLikeObject(value) {
  if (objectOrUndefined(value)) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    return !!objectOrUndefined(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

function toolArgumentsFromObject(value) {
  if (Object.prototype.hasOwnProperty.call(value, "arguments")) return value.arguments;
  if (Object.prototype.hasOwnProperty.call(value, "args")) return value.args;
  if (Object.prototype.hasOwnProperty.call(value, "input")) return value.input;
  if (objectOrUndefined(value.function)) return value.function.arguments;
  return undefined;
}

function containsToolCallLikeJsonArray(text, selectedToolNames = []) {
  const selected = new Set((Array.isArray(selectedToolNames) ? selectedToolNames : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean));
  for (const candidate of extractJsonArrayCandidates(text)) {
    const parsed = parseJsonArray(candidate);
    if (!parsed || parsed.length === 0) continue;
    if (parsed.some((item) => {
      const object = objectOrUndefined(item);
      if (!object) return false;
      const name = toolNameFromObject(object);
      if (!name || !argumentsLikeObject(toolArgumentsFromObject(object))) return false;
      const id = typeof object.id === "string" ? object.id : "";
      return selected.has(name) ||
        TOOL_CALL_LIKE_NAMES.has(name) ||
        /^until_done_[a-z0-9_]+$/i.test(name) ||
        /^pi_tool_/i.test(id);
    })) {
      return true;
    }
  }
  return false;
}

function isRawToolMarkupFinalAnswer(text) {
  const trimmed = String(text || "").trim();
  return containsRawPiToolMarkup(trimmed) || containsToolCallLikeJsonArray(trimmed);
}

function isToolEnvelopeOnlyFinalAnswer(text) {
  const trimmed = String(text || "").trim();
  return containsRawPiToolMarkup(trimmed) && stripPiToolEnvelopes(trimmed).length === 0;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map(String))].sort();
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => typeof value === "number" && Number.isFinite(value)))].sort((a, b) => a - b);
}

function uniqueBooleans(values) {
  return [...new Set(values.filter((value) => typeof value === "boolean"))].sort((a, b) => Number(a) - Number(b));
}

function boolOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function objectOrUndefined(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

module.exports = {
  boolOrUndefined,
  buildCaseSet,
  classifyRunKind,
  containsRawPiToolMarkup,
  containsToolCallLikeJsonArray,
  FULL_SUITE_CASE_NAMES,
  isRawToolMarkupFinalAnswer,
  isToolEnvelopeOnlyFinalAnswer,
  normalizeCaseSet,
  numberOrUndefined,
  numberOrZero,
  objectOrUndefined,
  readJsonFileAsObject,
  readJsonFile,
  readJsonlEvents,
  readJsonl,
  sortedUniqueStrings,
  stripPiToolEnvelopes,
  uniqueBooleans,
  uniqueNumbers,
  uniqueStrings,
};
