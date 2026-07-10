const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  detectToolCallLikeFinal,
} = require("./pi67-xtalpi-protocol-boundary-core.cjs");

const FULL_SUITE_CASE_NAMES = [
  "no-tool",
  "bash",
  "read",
  "bash-read",
  "web-read",
  "plan-mode-contract",
  "plan-mode-accepted-continuation",
  "read-enoent-recovery",
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

function containsToolCallLikeJsonArray(text, selectedToolNames = []) {
  return !detectToolCallLikeFinal({
    text,
    selectedToolNames: Array.isArray(selectedToolNames) ? selectedToolNames : [],
  }).ok;
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
  detectToolCallLikeFinal,
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
