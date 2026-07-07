const MAX_SCAN_CHARS = 12000;
const MAX_JSON_CANDIDATES = 16;

function objectOrUndefined(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function normalizeToolNameSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
}

function candidateToolNames(input = {}) {
  return normalizeToolNameSet([
    ...(Array.isArray(input.selectedToolNames) ? input.selectedToolNames : []),
    ...(Array.isArray(input.allToolNames) ? input.allToolNames : []),
  ]);
}

function jsonCandidateSlices(value) {
  const source = String(value || "").slice(0, MAX_SCAN_CHARS);
  const seen = new Set();
  const candidates = [];

  for (let start = 0; start < source.length; start += 1) {
    const root = source[start];
    if (root !== "{" && root !== "[") continue;

    const stack = [];
    let inString = false;
    let escaped = false;
    let invalid = false;

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
      if (char === "{") {
        stack.push("}");
        continue;
      }
      if (char === "[") {
        stack.push("]");
        continue;
      }
      if (char === "}" || char === "]") {
        if (stack.pop() !== char) {
          invalid = true;
          break;
        }
        if (stack.length === 0) {
          const raw = source.slice(start, index + 1);
          if (!seen.has(raw)) {
            seen.add(raw);
            candidates.push(raw);
          }
          break;
        }
      }
    }

    if (invalid) continue;
    if (candidates.length >= MAX_JSON_CANDIDATES) break;
  }

  return candidates;
}

function parseJsonCandidate(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringField(value, key) {
  const raw = value?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function idLike(value) {
  return stringField(value, "id") || stringField(value, "tool_call_id") || stringField(value, "call_id") || "";
}

function toolNameFromObject(value) {
  if (!objectOrUndefined(value)) return undefined;
  return stringField(value, "name") ||
    stringField(value, "tool") ||
    stringField(value, "tool_name") ||
    stringField(value, "function_name") ||
    (objectOrUndefined(value.function) ? stringField(value.function, "name") : undefined);
}

function toolArgumentsFromObject(value) {
  if (!objectOrUndefined(value)) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, "arguments")) return value.arguments;
  if (Object.prototype.hasOwnProperty.call(value, "args")) return value.args;
  if (Object.prototype.hasOwnProperty.call(value, "input")) return value.input;
  if (Object.prototype.hasOwnProperty.call(value, "parameters")) return value.parameters;
  if (Object.prototype.hasOwnProperty.call(value, "arguments_json")) return value.arguments_json;
  if (objectOrUndefined(value.function)) return value.function.arguments;
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

function isReservedPiToolName(name) {
  return /^until_done_[a-z0-9_]+$/i.test(name);
}

function isPiToolId(id) {
  return /^pi_tool_/i.test(id);
}

function makeFinding(input) {
  return {
    ok: false,
    code: input.code,
    matchedShape: input.matchedShape,
    matchedToolName: input.matchedToolName,
    reason:
      "model returned tool-call-like JSON/protocol content in final text; " +
      "tool calls must be emitted as exactly one canonical local action object",
  };
}

function detectNamedToolObject(input) {
  const object = objectOrUndefined(input.value);
  if (!object) return undefined;

  const name = toolNameFromObject(object);
  if (!name) return undefined;
  if (!argumentsLikeObject(toolArgumentsFromObject(object))) return undefined;

  const matched =
    input.protocolWrapper === true ||
    input.toolNames.has(name) ||
    isReservedPiToolName(name) ||
    isPiToolId(idLike(object));
  if (!matched) return undefined;

  return makeFinding({
    code: input.code,
    matchedShape: input.matchedShape,
    matchedToolName: name,
  });
}

function detectProtocolObject(value, toolNames, fallbackCode) {
  if (value.kind === "tool_call") {
    return detectNamedToolObject({
      value,
      toolNames,
      code: "tool_call_like_json_object",
      matchedShape: "json_action_tool_call",
      protocolWrapper: true,
    });
  }

  if (Array.isArray(value.tool_calls)) {
    for (const item of value.tool_calls) {
      const itemObject = objectOrUndefined(item);
      const functionValue = itemObject && objectOrUndefined(itemObject.function) ? itemObject.function : item;
      const finding = detectNamedToolObject({
        value: functionValue,
        toolNames,
        code: "openai_tool_calls_final",
        matchedShape: "openai_tool_calls",
        protocolWrapper: true,
      });
      if (finding) return finding;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, "function_call")) {
    const finding = detectNamedToolObject({
      value: value.function_call,
      toolNames,
      code: "function_call_final",
      matchedShape: "function_call",
      protocolWrapper: true,
    });
    if (finding) return finding;
  }

  if (objectOrUndefined(value.function)) {
    const finding = detectNamedToolObject({
      value: value.function,
      toolNames,
      code: "function_call_final",
      matchedShape: "function",
      protocolWrapper: true,
    });
    if (finding) return finding;
  }

  return detectNamedToolObject({
    value,
    toolNames,
    code: fallbackCode,
    matchedShape: fallbackCode === "tool_call_like_json_array" ? "json_array_item" : "json_object",
  });
}

function detectParsedCandidate(parsed, toolNames) {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const itemObject = objectOrUndefined(item);
      if (!itemObject) continue;
      const finding = detectProtocolObject(itemObject, toolNames, "tool_call_like_json_array");
      if (!finding) continue;
      return finding.code === "tool_call_like_json_object"
        ? {
            ...finding,
            code: "tool_call_like_json_array",
            matchedShape: finding.matchedShape === "json_object" ? "json_array_item" : finding.matchedShape,
          }
        : finding;
    }
    return undefined;
  }

  const object = objectOrUndefined(parsed);
  if (!object) return undefined;
  return detectProtocolObject(object, toolNames, "tool_call_like_json_object");
}

function detectToolCallLikeFinal(input) {
  const toolNames = candidateToolNames(input);

  for (const raw of jsonCandidateSlices(input?.text || "")) {
    const parsed = parseJsonCandidate(raw);
    if (parsed === undefined) continue;
    const finding = detectParsedCandidate(parsed, toolNames);
    if (finding) return finding;
  }

  return { ok: true };
}

function containsToolCallLikeFinal(input) {
  return !detectToolCallLikeFinal(input).ok;
}

module.exports = {
  containsToolCallLikeFinal,
  detectToolCallLikeFinal,
  jsonCandidateSlices,
};
