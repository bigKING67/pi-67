export type ProtocolBoundaryFindingCode =
  | "tool_call_like_json_array"
  | "tool_call_like_json_object"
  | "openai_tool_calls_final"
  | "function_call_final";

export type ProtocolBoundaryFinding =
  | { ok: true }
  | {
      ok: false;
      code: ProtocolBoundaryFindingCode;
      reason: string;
      matchedToolName?: string;
      matchedShape: string;
    };

type ProtocolBoundaryViolation = Extract<ProtocolBoundaryFinding, { ok: false }>;

type JsonObject = Record<string, unknown>;

const MAX_SCAN_CHARS = 12000;
const MAX_JSON_CANDIDATES = 16;

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolNameSet(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
}

function candidateToolNames(input: {
  selectedToolNames?: readonly string[];
  allToolNames?: readonly string[];
}): Set<string> {
  return normalizeToolNameSet([...(input.selectedToolNames ?? []), ...(input.allToolNames ?? [])]);
}

function jsonCandidateSlices(value: string): string[] {
  const source = String(value ?? "").slice(0, MAX_SCAN_CHARS);
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (let start = 0; start < source.length; start += 1) {
    const root = source[start];
    if (root !== "{" && root !== "[") continue;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let invalid = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
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

function parseJsonCandidate(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringField(value: JsonObject, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function idLike(value: JsonObject): string {
  return stringField(value, "id") ?? stringField(value, "tool_call_id") ?? stringField(value, "call_id") ?? "";
}

function toolNameFromObject(value: JsonObject): string | undefined {
  return stringField(value, "name") ??
    stringField(value, "tool") ??
    stringField(value, "tool_name") ??
    stringField(value, "function_name") ??
    (isPlainObject(value.function) ? stringField(value.function, "name") : undefined);
}

function toolArgumentsFromObject(value: JsonObject): unknown {
  if (Object.prototype.hasOwnProperty.call(value, "arguments")) return value.arguments;
  if (Object.prototype.hasOwnProperty.call(value, "args")) return value.args;
  if (Object.prototype.hasOwnProperty.call(value, "input")) return value.input;
  if (Object.prototype.hasOwnProperty.call(value, "parameters")) return value.parameters;
  if (Object.prototype.hasOwnProperty.call(value, "arguments_json")) return value.arguments_json;
  if (isPlainObject(value.function)) return value.function.arguments;
  return undefined;
}

function argumentsLikeObject(value: unknown): boolean {
  if (isPlainObject(value)) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    return isPlainObject(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

function isReservedPiToolName(name: string): boolean {
  return /^until_done_[a-z0-9_]+$/i.test(name);
}

function isPiToolId(id: string): boolean {
  return /^pi_tool_/i.test(id);
}

function makeFinding(input: {
  code: ProtocolBoundaryFindingCode;
  matchedShape: string;
  matchedToolName?: string;
}): ProtocolBoundaryViolation {
  return {
    ok: false,
    code: input.code,
    matchedShape: input.matchedShape,
    ...(input.matchedToolName === undefined ? {} : { matchedToolName: input.matchedToolName }),
    reason:
      "model returned tool-call-like JSON/protocol content in final text; " +
      "tool calls must be emitted as exactly one canonical local action object",
  };
}

function detectNamedToolObject(input: {
  value: unknown;
  toolNames: Set<string>;
  code: ProtocolBoundaryFindingCode;
  matchedShape: string;
  protocolWrapper?: boolean;
}): ProtocolBoundaryViolation | undefined {
  if (!isPlainObject(input.value)) return undefined;

  const name = toolNameFromObject(input.value);
  if (!name) return undefined;
  if (!argumentsLikeObject(toolArgumentsFromObject(input.value))) return undefined;

  const matched =
    input.protocolWrapper === true ||
    input.toolNames.has(name) ||
    isReservedPiToolName(name) ||
    isPiToolId(idLike(input.value));
  if (!matched) return undefined;

  return makeFinding({
    code: input.code,
    matchedShape: input.matchedShape,
    matchedToolName: name,
  });
}

function detectProtocolObject(
  value: JsonObject,
  toolNames: Set<string>,
  fallbackCode: ProtocolBoundaryFindingCode,
): ProtocolBoundaryViolation | undefined {
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
      const functionValue = isPlainObject(item) && isPlainObject(item.function) ? item.function : item;
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

  if (isPlainObject(value.function)) {
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

function detectParsedCandidate(parsed: unknown, toolNames: Set<string>): ProtocolBoundaryViolation | undefined {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!isPlainObject(item)) continue;
      const finding = detectProtocolObject(item, toolNames, "tool_call_like_json_array");
      if (finding) {
        return finding.code === "tool_call_like_json_object"
          ? {
              ...finding,
              code: "tool_call_like_json_array",
              matchedShape: finding.matchedShape === "json_object" ? "json_array_item" : finding.matchedShape,
            }
          : finding;
      }
    }
    return undefined;
  }

  if (!isPlainObject(parsed)) return undefined;
  return detectProtocolObject(parsed, toolNames, "tool_call_like_json_object");
}

export function detectToolCallLikeFinal(input: {
  text: string;
  selectedToolNames?: readonly string[];
  allToolNames?: readonly string[];
}): ProtocolBoundaryFinding {
  const toolNames = candidateToolNames(input);

  for (const raw of jsonCandidateSlices(input.text)) {
    const parsed = parseJsonCandidate(raw);
    if (parsed === undefined) continue;
    const finding = detectParsedCandidate(parsed, toolNames);
    if (finding) return finding;
  }

  return { ok: true };
}

export function containsToolCallLikeFinal(input: {
  text: string;
  selectedToolNames?: readonly string[];
  allToolNames?: readonly string[];
}): boolean {
  return !detectToolCallLikeFinal(input).ok;
}
