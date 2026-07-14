import { safeInlineText } from "./text-safety.ts";
import {
  browserMcpToolRouteForName,
  detectBrowserMcpTaskText,
  preferredBrowserMcpToolName,
} from "./browser-bridge.ts";
import {
  detectVisionTaskText,
  preferredVisionToolName,
  visionToolRouteForName,
} from "./vision-bridge.ts";
import { serializeToolParameters } from "./tools/schema-serializer.ts";
import type { ToolLike } from "./tools/types.ts";

export type { ToolLike } from "./tools/types.ts";

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

export type ToolSelectionOptions = {
  boostedToolNames?: readonly string[];
  boostReasonCode?: string;
};

type ToolScore = {
  score: number;
  reasonCodes: string[];
};

type RankedTool = ToolScore & {
  tool: ToolLike;
  index: number;
};

type ToolSelectionVisionState = ReturnType<typeof detectVisionTaskText>;
type ToolSelectionBrowserState = ReturnType<typeof detectBrowserMcpTaskText>;

type ToolMentionContext = {
  start: number;
  end: number;
  leftClause: string;
};

type ToolScoringContext = {
  prompt: string;
  promptTokens: string[];
  hasUrl: boolean;
  hasPath: boolean;
  hasEditIntent: boolean;
  hasSearchIntent: boolean;
  visionState: ToolSelectionVisionState;
  browserState: ToolSelectionBrowserState;
  boostedToolNames: ReadonlySet<string>;
  boostReasonCode: string;
};

const MAX_TOOL_SELECTION_SUMMARY_ITEMS = 12;
const MAX_TOOL_SELECTION_REASON_CODES = 8;
const MAX_SERIALIZED_TOOLS_CHARS = 18_000;
const FORBIDDEN_TOOL_MENTION_PENALTY = -220;
const IMAGE_PATH_READ_PENALTY = -260;

const CORE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "ffgrep",
  "find",
  "fffind",
  "ls",
  "web_fetch",
  "web_search",
]);

const TOOL_NAME_BOUNDARY_CHARS = "A-Za-z0-9_-";
const EXCLUSIVE_TOOL_CLAUSE_PATTERN =
  /(?:\bonly\s+(?:the\s+)?(?:call|use|execute|run|invoke|select|choose)\b|\b(?:call|use|execute|run|invoke|select|choose)\s+only(?:\s+the)?\b|(?:只|仅)\s*(?:调用|使用|执行|运行|选择|用))/i;
const NEGATIVE_TOOL_CLAUSE_PATTERN =
  /(?:do\s+not|don't|dont|must\s+not|never|without)\s+(?:call|use|execute|run|invoke|select|choose)?|(?:禁止|不要|不得|别|勿)\s*(?:调用|使用|执行|运行|选择|用)?/i;
const TOOL_MENTION_EXCEPTION_PATTERN = /(?:except(?:\s+for)?|other\s+than|除外|除了|除非|以外|之外)/i;
const PROMPT_TOKEN_SPLIT_PATTERN = /[^a-z0-9_\-\u4e00-\u9fff/.]+/i;
const PROMPT_URL_PATTERN = /https?:\/\//i;
const PROMPT_PATH_PATTERN = /[~/./][^\s]*/;
const PROMPT_EDIT_INTENT_PATTERN = /(?:修改|编辑|修复|实现|patch|edit|write|create|delete|commit|push)/i;
const PROMPT_SEARCH_INTENT_PATTERN = /(?:搜索|查找|grep|find|search|rg)/i;
const WEB_TOOL_PATTERN = /web|fetch|http|url/i;
const FILE_TOOL_PATTERN = /read|file|path|grep|find|ls|bash/i;
const EDIT_TOOL_PATTERN = /edit|write|bash/i;
const SEARCH_TOOL_PATTERN = /grep|find|search/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toolNameMentionPattern(toolName: string): RegExp {
  return new RegExp(
    `(^|[^${TOOL_NAME_BOUNDARY_CHARS}])(${escapeRegExp(toolName)})(?=$|[^${TOOL_NAME_BOUNDARY_CHARS}])`,
    "gi",
  );
}

function toolNameMentionContexts(toolName: string, prompt: string): ToolMentionContext[] {
  if (!toolName) return [];
  const pattern = toolNameMentionPattern(toolName);
  const contexts: ToolMentionContext[] = [];
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

function hasExclusiveToolMention(contexts: readonly ToolMentionContext[]): boolean {
  return contexts.some((context) =>
    EXCLUSIVE_TOOL_CLAUSE_PATTERN.test(context.leftClause),
  );
}

function hasForbiddenToolMention(contexts: readonly ToolMentionContext[], prompt: string): boolean {
  for (const { end, leftClause } of contexts) {
    const rightWindow = prompt.slice(end, end + 24);
    const leftTail = leftClause.slice(-32);

    if (!NEGATIVE_TOOL_CLAUSE_PATTERN.test(leftClause)) continue;
    if (TOOL_MENTION_EXCEPTION_PATTERN.test(leftTail) || TOOL_MENTION_EXCEPTION_PATTERN.test(rightWindow)) continue;
    return true;
  }
  return false;
}

function buildToolScoringContext(
  prompt: string,
  visionState: ToolSelectionVisionState,
  browserState: ToolSelectionBrowserState,
  selectionOptions: ToolSelectionOptions,
): ToolScoringContext {
  const promptLower = prompt.toLowerCase();
  return {
    prompt,
    promptTokens: promptLower.split(PROMPT_TOKEN_SPLIT_PATTERN).filter((token) => token.length >= 2),
    hasUrl: PROMPT_URL_PATTERN.test(prompt),
    hasPath: PROMPT_PATH_PATTERN.test(prompt),
    hasEditIntent: PROMPT_EDIT_INTENT_PATTERN.test(prompt),
    hasSearchIntent: PROMPT_SEARCH_INTENT_PATTERN.test(prompt),
    visionState,
    browserState,
    boostedToolNames: new Set(selectionOptions.boostedToolNames ?? []),
    boostReasonCode: selectionOptions.boostReasonCode || "recovery_tool_boost",
  };
}

function scoreTool(
  tool: ToolLike,
  context: ToolScoringContext,
): ToolScore {
  const description = typeof tool.description === "string" ? tool.description.slice(0, 1000) : "";
  const haystack = `${tool.name} ${description}`.toLowerCase();
  const reasonCodes = new Set<string>();
  let score = 0;
  const addScore = (points: number, reasonCode: string) => {
    score += points;
    reasonCodes.add(reasonCode);
  };

  const mentionContexts = toolNameMentionContexts(tool.name, context.prompt);
  const forbiddenMention = hasForbiddenToolMention(mentionContexts, context.prompt);
  if (CORE_TOOL_NAMES.has(tool.name)) addScore(25, "core_tool");
  if (hasExclusiveToolMention(mentionContexts)) addScore(160, "prompt_tool_exclusive");
  if (mentionContexts.length > 0) addScore(100, "prompt_tool_name");
  if (forbiddenMention) addScore(FORBIDDEN_TOOL_MENTION_PENALTY, "prompt_tool_forbidden");
  if (!forbiddenMention && context.boostedToolNames.has(tool.name)) {
    addScore(320, context.boostReasonCode);
  }

  for (const token of context.promptTokens) {
    if (haystack.includes(token)) addScore(token.length > 4 ? 8 : 3, "prompt_token_match");
  }

  if (context.hasUrl && WEB_TOOL_PATTERN.test(haystack)) addScore(60, "prompt_url_web");
  if (context.hasPath && FILE_TOOL_PATTERN.test(haystack)) {
    addScore(35, "prompt_path_file");
  }
  if (context.visionState.isVisionTask) {
    const visionRoute = visionToolRouteForName(tool.name);
    if (visionRoute) {
      addScore(visionRoute.kind === "semantic" ? 520 : 460, "vision_bridge_route");
      for (const reasonCode of context.visionState.reasonCodes) addScore(0, reasonCode);
    } else if (context.visionState.hasImagePath && FILE_TOOL_PATTERN.test(haystack)) {
      addScore(IMAGE_PATH_READ_PENALTY, "image_path_read_penalty");
    }
  }
  if (context.browserState.isBrowserMcpTask) {
    const browserRoute = browserMcpToolRouteForName(tool.name);
    if (browserRoute) {
      addScore(browserRoute === "mcp_gateway" ? 500 : 460, "browser_mcp_route");
      for (const reasonCode of context.browserState.reasonCodes) addScore(0, reasonCode);
    }
  }
  if (context.hasEditIntent && EDIT_TOOL_PATTERN.test(haystack)) {
    addScore(35, "prompt_edit_intent");
  }
  if (context.hasSearchIntent && SEARCH_TOOL_PATTERN.test(haystack)) {
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
  selectionOptions: ToolSelectionOptions = {},
): ToolSelectionResult {
  const totalToolCount = tools?.length ?? 0;
  const limit = normalizeMaxTools(maxTools);
  const available = collectValidTools(tools);
  const visionState = detectVisionTaskText(prompt);
  const browserState = detectBrowserMcpTaskText(prompt);
  const scoringContext = buildToolScoringContext(prompt, visionState, browserState, selectionOptions);
  const scored = available.map((tool, index) => ({
    tool,
    index,
    ...scoreTool(tool, scoringContext),
  }));
  const preferredVisionName = visionState.isVisionTask && limit > 0 ? preferredVisionToolName(available) : undefined;
  const preferredBrowserMcpName = browserState.isBrowserMcpTask && limit > 0
    ? preferredBrowserMcpToolName(available)
    : undefined;
  const exclusiveToolNames = new Set(
    scored
      .filter((item) => item.reasonCodes.includes("prompt_tool_exclusive"))
      .map((item) => item.tool.name),
  );
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const selectedRanked = (() => {
    if (preferredVisionName) {
      return ranked.filter((item) => item.tool.name === preferredVisionName).slice(0, 1);
    }
    if (preferredBrowserMcpName) {
      return ranked.filter((item) => item.tool.name === preferredBrowserMcpName).slice(0, 1);
    }
    if (exclusiveToolNames.size > 0) {
      const exclusiveRanked = ranked.filter((item) => exclusiveToolNames.has(item.tool.name));
      return exclusiveRanked.length > limit ? exclusiveRanked.slice(0, limit) : exclusiveRanked;
    }
    return scored.length > limit ? ranked.slice(0, limit) : scored;
  })();
  const selectedToolNameSet = availableToolNames(selectedRanked.map((item) => item.tool));
  const omittedRanked = preferredVisionName || preferredBrowserMcpName || exclusiveToolNames.size > 0 || scored.length > limit
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

  const header = `Available Pi tools (${selected.length}/${totalToolCount}; call only one at a time):`;
  const perToolSchemaChars = Math.max(
    240,
    Math.min(1500, Math.floor((MAX_SERIALIZED_TOOLS_CHARS - header.length) / selected.length) - 300),
  );
  const entries = selected.map((tool) => {
    const name = safeInlineText(tool.name, 160);
    const description = safeInlineText(tool.description ?? "No description", 240);
    const schema = serializeToolParameters(tool.parameters, { maxToolChars: perToolSchemaChars });
    return `- ${name}: ${description}\n  arguments: ${schema}`;
  });
  const serialized = [header, ...entries].join("\n");
  return serialized.length <= MAX_SERIALIZED_TOOLS_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_SERIALIZED_TOOLS_CHARS - 20)}\n...[tools clipped]`;
}

export function serializeAvailableTools(tools: ToolLike[] | undefined, prompt: string, maxTools: number): string {
  const selected = selectTools(tools, prompt, maxTools);
  return serializeSelectedTools(selected, tools?.length ?? selected.length);
}
