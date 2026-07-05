import { safeInlineText } from "./text-safety.ts";

export type ToolLike = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type ToolSelectionItem = {
  name: string;
  index: number;
  score: number;
  selected: boolean;
  reasonCodes: string[];
};

export type ToolSelectionSummary = {
  schema: "xtalpi-pi-tools.tool-selection.v1";
  totalToolCount: number;
  validToolCount: number;
  maxTools: number;
  clipped: boolean;
  omittedToolCount: number;
  selected: ToolSelectionItem[];
  omitted: ToolSelectionItem[];
};

export type ToolSelectionResult = {
  selectedTools: ToolLike[];
  selectedToolNames: Set<string>;
  summary: ToolSelectionSummary;
};

type ToolScore = {
  score: number;
  reasonCodes: string[];
};

type RankedTool = ToolScore & {
  tool: ToolLike;
  index: number;
};

const MAX_TOOL_SELECTION_SUMMARY_ITEMS = 12;
const MAX_TOOL_SELECTION_REASON_CODES = 8;
const FORBIDDEN_TOOL_MENTION_PENALTY = -220;

const CORE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_fetch",
  "web_search",
]);

const TOOL_NAME_BOUNDARY_CHARS = "A-Za-z0-9_-";
const EXCLUSIVE_TOOL_CLAUSE_PATTERN =
  /(?:\bonly\s+(?:the\s+)?(?:call|use|execute|run|invoke|select|choose)?|\b(?:call|use|execute|run|invoke|select|choose)\s+only(?:\s+the)?|(?:只|仅)\s*(?:调用|使用|执行|运行|选择|用)?)/i;
const NEGATIVE_TOOL_CLAUSE_PATTERN =
  /(?:do\s+not|don't|dont|must\s+not|never|without)\s+(?:call|use|execute|run|invoke|select|choose)?|(?:禁止|不要|不得|别|勿)\s*(?:调用|使用|执行|运行|选择|用)?/i;
const TOOL_MENTION_EXCEPTION_PATTERN = /(?:except(?:\s+for)?|other\s+than|除外|除了|除非|以外|之外)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toolNameMentionPattern(toolName: string): RegExp {
  return new RegExp(
    `(^|[^${TOOL_NAME_BOUNDARY_CHARS}])(${escapeRegExp(toolName)})(?=$|[^${TOOL_NAME_BOUNDARY_CHARS}])`,
    "gi",
  );
}

function hasToolNameMention(toolName: string, prompt: string): boolean {
  if (!toolName) return false;
  return toolNameMentionPattern(toolName).test(prompt);
}

function toolNameMentionContexts(toolName: string, prompt: string): Array<{
  start: number;
  end: number;
  leftClause: string;
}> {
  const pattern = toolNameMentionPattern(toolName);
  const contexts: Array<{ start: number; end: number; leftClause: string }> = [];
  for (const match of prompt.matchAll(pattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + prefixLength;
    const end = start + toolName.length;
    const clauseStart = Math.max(
      prompt.lastIndexOf("\n", start - 1),
      prompt.lastIndexOf(".", start - 1),
      prompt.lastIndexOf(";", start - 1),
      prompt.lastIndexOf("。", start - 1),
      prompt.lastIndexOf("；", start - 1),
      prompt.lastIndexOf("！", start - 1),
      prompt.lastIndexOf("？", start - 1),
      prompt.lastIndexOf("!", start - 1),
      prompt.lastIndexOf("?", start - 1),
    );
    contexts.push({ start, end, leftClause: prompt.slice(clauseStart + 1, start) });
  }
  return contexts;
}

function hasExclusiveToolMention(toolName: string, prompt: string): boolean {
  return toolNameMentionContexts(toolName, prompt).some((context) =>
    EXCLUSIVE_TOOL_CLAUSE_PATTERN.test(context.leftClause),
  );
}

function hasForbiddenToolMention(toolName: string, prompt: string): boolean {
  if (!toolName) return false;
  for (const { end, leftClause } of toolNameMentionContexts(toolName, prompt)) {
    const rightWindow = prompt.slice(end, end + 24);
    const leftTail = leftClause.slice(-32);

    if (!NEGATIVE_TOOL_CLAUSE_PATTERN.test(leftClause)) continue;
    if (TOOL_MENTION_EXCEPTION_PATTERN.test(leftTail) || TOOL_MENTION_EXCEPTION_PATTERN.test(rightWindow)) continue;
    return true;
  }
  return false;
}

function schemaType(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") return record.type;
  if (Array.isArray(record.anyOf)) return "anyOf";
  if (Array.isArray(record.oneOf)) return "oneOf";
  return "object";
}

function summarizeParameters(parameters: unknown): string {
  if (typeof parameters !== "object" || parameters === null) return "args: object";
  const schema = parameters as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const properties = typeof schema.properties === "object" && schema.properties !== null
    ? (schema.properties as Record<string, unknown>)
    : {};
  const entries = Object.entries(properties).slice(0, 12);
  if (entries.length === 0) return "args: object";

  return entries
    .map(([name, prop]) => {
      const marker = required.has(name) ? "required" : "optional";
      const displayName = safeInlineText(name, 120);
      const displayType = safeInlineText(schemaType(prop), 80);
      let description = "";
      if (typeof prop === "object" && prop !== null && typeof (prop as Record<string, unknown>).description === "string") {
        description = ` - ${safeInlineText((prop as Record<string, unknown>).description, 120)}`;
      }
      return `${displayName}:${displayType} ${marker}${description}`;
    })
    .join("; ");
}

function scoreTool(tool: ToolLike, prompt: string): ToolScore {
  const description = typeof tool.description === "string" ? tool.description.slice(0, 1000) : "";
  const haystack = `${tool.name} ${description}`.toLowerCase();
  const promptLower = prompt.toLowerCase();
  const reasonCodes = new Set<string>();
  let score = 0;
  const addScore = (points: number, reasonCode: string) => {
    score += points;
    reasonCodes.add(reasonCode);
  };

  if (CORE_TOOL_NAMES.has(tool.name)) addScore(25, "core_tool");
  if (hasExclusiveToolMention(tool.name, prompt)) addScore(160, "prompt_tool_exclusive");
  if (hasToolNameMention(tool.name, prompt)) addScore(100, "prompt_tool_name");
  if (hasForbiddenToolMention(tool.name, prompt)) addScore(FORBIDDEN_TOOL_MENTION_PENALTY, "prompt_tool_forbidden");

  for (const token of promptLower.split(/[^a-z0-9_\-\u4e00-\u9fff/.]+/i)) {
    if (token.length < 2) continue;
    if (haystack.includes(token)) addScore(token.length > 4 ? 8 : 3, "prompt_token_match");
  }

  if (/https?:\/\//i.test(prompt) && /web|fetch|http|url/i.test(haystack)) addScore(60, "prompt_url_web");
  if (/[~/./][^\s]*/.test(prompt) && /read|file|path|grep|find|ls|bash/i.test(haystack)) {
    addScore(35, "prompt_path_file");
  }
  if (/(修改|编辑|修复|实现|patch|edit|write|create|delete|commit|push)/i.test(prompt) && /edit|write|bash/i.test(haystack)) {
    addScore(35, "prompt_edit_intent");
  }
  if (/(搜索|查找|grep|find|search|rg)/i.test(prompt) && /grep|find|search/i.test(haystack)) {
    addScore(35, "prompt_search_intent");
  }

  return { score, reasonCodes: [...reasonCodes].slice(0, MAX_TOOL_SELECTION_REASON_CODES).sort() };
}

function normalizeMaxTools(maxTools: number): number {
  if (!Number.isFinite(maxTools)) return 0;
  return Math.max(0, Math.floor(maxTools));
}

function collectValidTools(tools: ToolLike[] | undefined): ToolLike[] {
  const result: ToolLike[] = [];
  const seenNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (!tool || typeof tool.name !== "string") continue;
    const name = tool.name.trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    result.push(name === tool.name ? tool : { ...tool, name });
  }
  return result;
}

function summarizeRankedTool(item: RankedTool, selected: boolean): ToolSelectionItem {
  return {
    name: safeInlineText(item.tool.name, 160),
    index: item.index,
    score: item.score,
    selected,
    reasonCodes: item.reasonCodes,
  };
}

function boundedSelectionItems(items: RankedTool[], selected: boolean): ToolSelectionItem[] {
  return items
    .slice(0, MAX_TOOL_SELECTION_SUMMARY_ITEMS)
    .map((item) => summarizeRankedTool(item, selected));
}

export function availableToolNames(tools: ToolLike[] | undefined): Set<string> {
  return new Set((tools ?? []).map((tool) => tool.name).filter(Boolean));
}

export function selectToolsWithSummary(
  tools: ToolLike[] | undefined,
  prompt: string,
  maxTools: number,
): ToolSelectionResult {
  const totalToolCount = tools?.length ?? 0;
  const limit = normalizeMaxTools(maxTools);
  const available = collectValidTools(tools);
  const scored = available.map((tool, index) => ({ tool, index, ...scoreTool(tool, prompt) }));
  const exclusiveToolNames = new Set(
    scored
      .filter((item) => item.reasonCodes.includes("prompt_tool_exclusive"))
      .map((item) => item.tool.name),
  );
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const selectedRanked = (() => {
    if (exclusiveToolNames.size > 0) {
      const exclusiveRanked = ranked.filter((item) => exclusiveToolNames.has(item.tool.name));
      return exclusiveRanked.length > limit ? exclusiveRanked.slice(0, limit) : exclusiveRanked;
    }
    return scored.length > limit ? ranked.slice(0, limit) : scored;
  })();
  const selectedToolNameSet = availableToolNames(selectedRanked.map((item) => item.tool));
  const omittedRanked = exclusiveToolNames.size > 0 || scored.length > limit
    ? ranked.filter((item) => !selectedToolNameSet.has(item.tool.name))
    : [];
  const clipped = omittedRanked.length > 0;
  const selectedTools = selectedRanked.map((item) => item.tool);
  const selectedToolNames = availableToolNames(selectedTools);
  const summary: ToolSelectionSummary = {
    schema: "xtalpi-pi-tools.tool-selection.v1",
    totalToolCount,
    validToolCount: available.length,
    maxTools: limit,
    clipped,
    omittedToolCount: omittedRanked.length,
    selected: boundedSelectionItems(selectedRanked, true),
    omitted: boundedSelectionItems(omittedRanked, false),
  };

  return { selectedTools, selectedToolNames, summary };
}

export function selectTools(tools: ToolLike[] | undefined, prompt: string, maxTools: number): ToolLike[] {
  return selectToolsWithSummary(tools, prompt, maxTools).selectedTools;
}

export function serializeSelectedTools(selected: ToolLike[], totalToolCount: number): string {
  if (selected.length === 0) {
    return "No Pi tools are available in this turn. Answer normally without tool envelopes.";
  }

  return [
    `Available Pi tools (${selected.length}/${totalToolCount}; call only one at a time):`,
    ...selected.map((tool) => {
      const name = safeInlineText(tool.name, 160);
      const description = safeInlineText(tool.description ?? "No description", 240);
      return `- ${name}: ${description}\n  arguments: ${summarizeParameters(tool.parameters)}`;
    }),
  ].join("\n");
}

export function serializeAvailableTools(tools: ToolLike[] | undefined, prompt: string, maxTools: number): string {
  const selected = selectTools(tools, prompt, maxTools);
  return serializeSelectedTools(selected, tools?.length ?? selected.length);
}
