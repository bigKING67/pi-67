import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AssistantMessage = {
  role: string;
  provider?: string;
  model?: string;
  content?: Array<Record<string, unknown>>;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
};

type AgentMessage = AssistantMessage & {
  customType?: string;
};

const RECOVERY_CUSTOM_TYPE = "xtalpi-compat.recovery";
const RECOVERY_PROMPT_MARKER = "[xtalpi-compat-recovery]";
const MAX_HIDDEN_RECOVERIES = 2;
const MAX_HIDDEN_RECOVERIES_PER_TURN = 4;

const RECOVERY_PROMPT = `${RECOVERY_PROMPT_MARKER}
上一轮 xtalpi 返回了空 assistant 内容。请基于上面的工具结果或用户问题继续，必须输出非空内容：如果已有工具结果，请直接阅读工具结果并给出最终回复，不要重复调用工具；如果还没有工具结果且确实需要工具，只发起必要的一个工具调用。`;

const XTALPI_RECOVERY_NO_TOOLS_POLICY_MARKER = "[xtalpi-compat-recovery-no-tools]";
const XTALPI_RECOVERY_NO_TOOLS_POLICY = `${XTALPI_RECOVERY_NO_TOOLS_POLICY_MARKER}
XTALPI EMPTY ASSISTANT RESCUE MODE:
- The previous xtalpi response had no assistant content.
- Do not call tools in this recovery request.
- Read the prior conversation and any [xtalpi-compat-tool-result] blocks directly.
- Produce a concise final answer in normal assistant text.
- If there is not enough information to finish, say exactly what is missing and give the next command or next user action.`;

const FINAL_FAILURE_TEXT =
  "xtalpi 连续返回空 assistant 内容，我已停止自动续问以避免无限循环。pi-67 已尝试本地 anti-stall 恢复；请重发上一句，或使用 `bash ~/.pi/agent/scripts/pi67-xtalpi-safe.sh` 以更保守模式继续。";

const XTALPI_MODEL_IDS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "xtalpi-science-flagship",
  "xtalpi-science-standard",
]);

const XTALPI_PROVIDER_IDS = new Set(["xtalpi", "xtalpi-tools"]);

const XTALPI_TOOL_POLICY_MARKER = "[xtalpi-compat-tool-policy]";
const XTALPI_TOOL_POLICY = `${XTALPI_TOOL_POLICY_MARKER}
XTALPI TOOL POLICY:
- If an exact local path is known, call read on that path directly. Do not search for it.
- For URLs, use web_fetch first. If it returns 404 and a local installed path is already known, read that local path directly.
- Avoid broad home-directory searches for short or generic words. Search only when no concrete path, URL, package name, symbol, or filename is available.
- Use one narrow search step before reading a concrete match. Prefer concrete paths over exploratory search.
- Call tools serially. Do not issue multiple sibling tool calls in one assistant message.
- After a tool result is returned, read the tool result text directly before deciding whether more tools are needed.`;

const XTALPI_READ_RESULT_POLICY_MARKER = "[xtalpi-compat-read-result-policy]";
const XTALPI_READ_RESULT_POLICY = `${XTALPI_READ_RESULT_POLICY_MARKER}
The previous read tool result is successful and non-empty. Do not say the file is missing or empty. Do not call more tools for this read-only summary question. Answer from the tool result now.`;

const XTALPI_TOOL_RESULT_MIRROR_MARKER = "[xtalpi-compat-tool-result]";
const DEFAULT_MAX_MIRRORED_TOOL_RESULT_CHARS = 12000;
const DEFAULT_MAX_XTALPI_TOOLS = 12;
const XTALPI_COMPAT_DEBUG_PATH = "$HOME/tmp/xtalpi-compat-debug.jsonl";

const READ_ONLY_SUMMARY_RE =
  /(总结|说明|解释|查看|阅读|读取|分析|是什么|有哪些|summary|summari[sz]e|explain|inspect|read|what)/i;
const WRITE_OR_BUILD_INTENT_RE =
  /(修改|修复|实现|编辑|写入|创建|删除|提交|推送|上传|安装|更新|改成|整理上传|apply|patch|edit|write|fix|implement|create|delete|commit|push|install|update|upload)/i;

type ProviderPayload = Record<string, unknown> & {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  parallel_tool_calls?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
};

type EmptyAssistantStrategy = "rescue_no_tools" | "hidden_recovery" | "fail_fast";

const CORE_READ_TOOLS = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind"]);
const CORE_WRITE_TOOLS = new Set(["edit", "write"]);
const CORE_COMMAND_TOOLS = new Set(["bash"]);
const WEB_TOOL_NAMES = new Set(["web_fetch", "batch_web_fetch", "web_search", "fetch_content", "get_search_content"]);
const TOOL_NAME_PART_STOPWORDS = new Set([
  "agent",
  "tool",
  "tools",
  "list",
  "get",
  "set",
  "user",
  "status",
  "request",
  "response",
  "export",
  "import",
  "create",
  "delete",
  "update",
]);

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null || !("text" in block)) {
        return "";
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function messageKey(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || !("role" in message)) {
    return undefined;
  }

  const msg = message as {
    role?: unknown;
    toolCallId?: unknown;
    content?: unknown;
  };

  if (typeof msg.role !== "string") {
    return undefined;
  }

  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const timestamp = "timestamp" in msg ? String((msg as { timestamp?: unknown }).timestamp ?? "") : "";
  const stopReason = "stopReason" in msg ? String((msg as { stopReason?: unknown }).stopReason ?? "") : "";
  return [msg.role, toolCallId, timestamp, stopReason, contentText(msg.content)].join(":");
}

function hasActionableContent(message: AssistantMessage): boolean {
  return (message.content ?? []).some((block) => {
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    if (block.type === "toolCall") {
      return typeof block.name === "string" && block.name.trim().length > 0;
    }
    return false;
  });
}

function isEmptyXtalpiAssistant(message: unknown): message is AssistantMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const msg = message as AssistantMessage;
  if (msg.role !== "assistant" || !isXtalpiProvider(msg.provider)) {
    return false;
  }

  if (
    msg.stopReason !== "stop" &&
    msg.stopReason !== "toolUse" &&
    !isRecoverableXtalpiStreamError(msg)
  ) {
    return false;
  }

  return !hasActionableContent(msg);
}

function isRecoverableXtalpiStreamError(message: AssistantMessage): boolean {
  return (
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    /stream ended without (assistant content|finish_reason)/i.test(message.errorMessage)
  );
}

function isRecoveryMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const msg = message as AgentMessage;
  return msg.role === "custom" && msg.customType === RECOVERY_CUSTOM_TYPE;
}

function recoveryFallbackMessage(message: AssistantMessage, latestToolExcerpt?: string): AssistantMessage {
  const safeExcerpt = latestToolExcerpt ? formatFallbackToolExcerpt(latestToolExcerpt) : undefined;
  const text = safeExcerpt
    ? `${FINAL_FAILURE_TEXT}\n\n最近一次工具结果摘录如下；如果这已经足够，请基于它继续处理：\n\n\`\`\`text\n${safeExcerpt}\n\`\`\``
    : FINAL_FAILURE_TEXT;

  return {
    ...message,
    stopReason: "stop",
    errorMessage: undefined,
    content: [{ type: "text", text }],
  };
}

function getToolName(tool: unknown): string | undefined {
  if (typeof tool === "string") {
    return tool;
  }
  if (
    typeof tool === "object" &&
    tool !== null &&
    "function" in tool &&
    typeof (tool as { function?: unknown }).function === "object" &&
    (tool as { function?: unknown }).function !== null &&
    "name" in ((tool as { function?: Record<string, unknown> }).function ?? {})
  ) {
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    return typeof name === "string" ? name : undefined;
  }
  if (typeof tool === "object" && tool !== null && "name" in tool) {
    const name = (tool as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function isXtalpiProvider(provider: unknown): boolean {
  return typeof provider === "string" && XTALPI_PROVIDER_IDS.has(provider);
}

function isXtalpiPayload(payload: unknown, provider: unknown): payload is ProviderPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const model = (payload as ProviderPayload).model;
  return isXtalpiProvider(provider) && typeof model === "string" && XTALPI_MODEL_IDS.has(model);
}

function envValue(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function emptyAssistantStrategy(): EmptyAssistantStrategy {
  const raw = envValue("XTALPI_EMPTY_ASSISTANT_STRATEGY")?.trim().toLowerCase();
  if (raw === "fail_fast" || raw === "fail-fast" || raw === "fail") {
    return "fail_fast";
  }
  if (raw === "hidden_recovery" || raw === "hidden-recovery" || raw === "retry") {
    return "hidden_recovery";
  }
  return "rescue_no_tools";
}

function toolResultMirrorMode(): "always" | "auto" | "off" {
  const raw = envValue("XTALPI_TOOL_RESULT_MIRROR")?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") {
    return "off";
  }
  if (raw === "auto") {
    return "auto";
  }
  return "always";
}

function shouldMirrorToolResults(messages: unknown): boolean {
  const mode = toolResultMirrorMode();
  if (mode === "off") {
    return false;
  }
  return hasToolHistory(messages);
}

function maxMirroredToolResultChars(): number {
  const raw = envValue("XTALPI_MAX_MIRRORED_TOOL_RESULT_CHARS");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 200000) {
    return parsed;
  }
  return DEFAULT_MAX_MIRRORED_TOOL_RESULT_CHARS;
}

function toolFilterMode(): "auto" | "off" {
  const raw = envValue("XTALPI_TOOL_FILTER")?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") {
    return "off";
  }
  return "auto";
}

function maxXtalpiTools(): number {
  const raw = envValue("XTALPI_MAX_TOOLS");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 8 && parsed <= 128) {
    return parsed;
  }
  return DEFAULT_MAX_XTALPI_TOOLS;
}

function includeFallbackToolExcerpt(): boolean {
  const raw = envValue("XTALPI_FALLBACK_INCLUDE_TOOL_EXCERPT")?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function debugEnabled(): boolean {
  const raw = envValue("XTALPI_COMPAT_DEBUG")?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function debugLog(event: string, data: Record<string, unknown>): void {
  if (!debugEnabled()) {
    return;
  }

  try {
    const path = expandHomePath(envValue("XTALPI_COMPAT_DEBUG_PATH") || XTALPI_COMPAT_DEBUG_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...data,
      })}\n`,
    );
  } catch {
    // Debug logging must never break normal agent execution.
  }
}

function expandHomePath(path: string): string {
  const home = envValue("HOME");
  if (!home) {
    return path;
  }
  if (path === "$HOME") {
    return home;
  }
  if (path.startsWith("$HOME/")) {
    return `${home}${path.slice("$HOME".length)}`;
  }
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return `${home}${path.slice(1)}`;
  }
  return path;
}

function summarizeRoles(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message) => {
    if (typeof message !== "object" || message === null) {
      return "unknown";
    }
    const role = (message as { role?: unknown }).role;
    return typeof role === "string" ? role : "unknown";
  });
}

function countToolResultMirrors(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }

  return messages.filter((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }
    const msg = message as { role?: unknown; content?: unknown };
    return msg.role === "user" && payloadContentText(msg.content).includes(XTALPI_TOOL_RESULT_MIRROR_MARKER);
  }).length;
}

function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[_./:-]+/g, " ");
}

function hasAny(prompt: string, keywords: string[]): boolean {
  return keywords.some((keyword) => prompt.includes(keyword));
}

function toolDescription(tool: unknown): string {
  if (typeof tool !== "object" || tool === null) {
    return "";
  }

  if (
    "function" in tool &&
    typeof (tool as { function?: unknown }).function === "object" &&
    (tool as { function?: unknown }).function !== null
  ) {
    const fn = (tool as { function?: { description?: unknown } }).function;
    return typeof fn?.description === "string" ? fn.description : "";
  }

  const description = (tool as { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

function collectHistoryToolNames(messages: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(messages)) {
    return names;
  }

  for (const name of collectToolCallNames(messages).values()) {
    names.add(name);
  }

  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const msg = message as { role?: unknown; name?: unknown };
    if (msg.role === "tool" && typeof msg.name === "string") {
      names.add(msg.name);
    }
  }

  return names;
}

function uniqueToolNames(names: Array<string | undefined>): string[] {
  return Array.from(new Set(names.filter((name): name is string => !!name)));
}

function payloadToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return uniqueToolNames(tools.map(getToolName));
}

function parseToolArguments(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  if (typeof args !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function inferToolNameFromArguments(args: unknown, availableToolNames: string[]): string | undefined {
  const parsed = parseToolArguments(args);
  if (!parsed) {
    return undefined;
  }

  const available = new Set(availableToolNames);
  const hasKey = (...keys: string[]) => keys.some((key) => key in parsed);

  if (hasKey("command", "cmd", "script") && available.has("bash")) {
    return "bash";
  }

  if (hasKey("url", "urls") && available.has("web_fetch")) {
    return "web_fetch";
  }

  if (hasKey("query", "searchQuery") && available.has("web_search")) {
    return "web_search";
  }

  if (hasKey("pattern", "regex")) {
    if (available.has("ffgrep")) {
      return "ffgrep";
    }
    if (available.has("grep")) {
      return "grep";
    }
  }

  if (hasKey("path", "file", "filePath", "filepath") && available.has("read")) {
    return "read";
  }

  return undefined;
}

function scoreXtalpiTool(tool: unknown, prompt: string, historyToolNames: Set<string>): number {
  const name = getToolName(tool);
  if (!name) {
    return -1;
  }

  const normalizedPrompt = normalizeSearchText(prompt);
  const normalizedName = normalizeSearchText(name);
  const description = normalizeSearchText(toolDescription(tool));
  let score = 0;

  if (historyToolNames.has(name)) {
    score += 1000;
  }

  if (normalizedPrompt.includes(normalizedName)) {
    score += 500;
  }

  for (const part of normalizedName
    .split(/\s+/)
    .filter((item) => item.length >= 4 && !TOOL_NAME_PART_STOPWORDS.has(item))) {
    if (normalizedPrompt.includes(part)) {
      score += 80;
    }
  }

  if (CORE_READ_TOOLS.has(name)) {
    score += 80;
  }
  if (CORE_COMMAND_TOOLS.has(name)) {
    score += 70;
  }

  const wantsWrite = WRITE_OR_BUILD_INTENT_RE.test(prompt);
  if (CORE_WRITE_TOOLS.has(name)) {
    score += wantsWrite ? 90 : -40;
  }

  const hasUrl = /https?:\/\//i.test(prompt);
  if (hasUrl || hasAny(normalizedPrompt, ["url", "http", "https", "github", "website", "web", "网页", "网站", "链接", "访问"])) {
    if (WEB_TOOL_NAMES.has(name)) {
      score += 180;
    }
  }

  if (hasAny(normalizedPrompt, ["file", "path", "read", "grep", "find", "package", "json", "markdown", "文件", "路径", "读取", "搜索", "查找", "目录"])) {
    if (CORE_READ_TOOLS.has(name)) {
      score += 160;
    }
  }

  if (hasAny(normalizedPrompt, ["bash", "shell", "command", "terminal", "npm", "node", "git", "pwd", "命令", "终端", "执行"])) {
    if (CORE_COMMAND_TOOLS.has(name)) {
      score += 180;
    }
  }

  if (hasAny(normalizedPrompt, ["js reverse", "reverse", "signature", "sign", "hook", "xhr", "websocket", "逆向", "签名", "反爬", "加密"])) {
    if (normalizedName.startsWith("js reverse") || normalizedName.includes("js reverse")) {
      score += 220;
    }
  }

  if (hasAny(normalizedPrompt, ["image", "screenshot", "图片", "截图", "视觉", "画图", "生成图"])) {
    if (normalizedName.includes("image")) {
      score += 180;
    }
  }

  if (hasAny(normalizedPrompt, ["memory", "remember", "recall", "记忆", "记住", "回忆"])) {
    if (normalizedName.includes("memory") || normalizedName.includes("recall")) {
      score += 170;
    }
  }

  if (hasAny(normalizedPrompt, ["mcp", "server", "tool", "工具", "服务器"])) {
    if (normalizedName === "mcp" || description.includes("mcp")) {
      score += 160;
    }
  }

  if (hasAny(normalizedPrompt, ["subagent", "plan", "until done", "子代理", "计划", "持续执行"])) {
    if (normalizedName.includes("agent") || normalizedName.includes("plan") || normalizedName.includes("until done")) {
      score += 140;
    }
  }

  if (hasAny(normalizedPrompt, ["飞书", "lark", "审批", "日历", "文档", "表格", "会议", "邮件", "群聊"])) {
    if (normalizedName.includes("lark") || normalizedName === "mcp") {
      score += 220;
    }
  }

  return score;
}

function filterXtalpiTools(tools: unknown, messages: unknown, prompt: string): { tools: unknown; originalCount: number; keptNames: string[] } {
  if (!Array.isArray(tools)) {
    return { tools, originalCount: 0, keptNames: [] };
  }

  const originalCount = tools.length;
  const maxTools = maxXtalpiTools();
  if (toolFilterMode() === "off" || originalCount <= maxTools) {
    return {
      tools,
      originalCount,
      keptNames: tools.map(getToolName).filter((name): name is string => !!name),
    };
  }

  const historyToolNames = collectHistoryToolNames(messages);
  const ranked = tools
    .map((tool, index) => {
      const name = getToolName(tool);
      return {
        tool,
        index,
        name,
        score: scoreXtalpiTool(tool, prompt, historyToolNames),
      };
    })
    .filter((entry) => entry.name && entry.score > 0);

  const fallbackRanked =
    ranked.length > 0
      ? ranked
      : tools.map((tool, index) => ({ tool, index, name: getToolName(tool), score: 0 })).filter((entry) => entry.name);

  fallbackRanked.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = fallbackRanked.slice(0, maxTools);
  selected.sort((a, b) => a.index - b.index);

  return {
    tools: selected.map((entry) => entry.tool),
    originalCount,
    keptNames: selected.map((entry) => entry.name).filter((name): name is string => !!name),
  };
}

function appendPolicyToContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content.includes(XTALPI_TOOL_POLICY_MARKER)
      ? content
      : `${XTALPI_TOOL_POLICY}\n\n${content}`;
  }

  if (Array.isArray(content)) {
    const alreadyInjected = content.some((block) => {
      if (typeof block !== "object" || block === null || !("text" in block)) {
        return false;
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.includes(XTALPI_TOOL_POLICY_MARKER);
    });

    if (alreadyInjected) {
      return content;
    }

    return [{ type: "text", text: XTALPI_TOOL_POLICY }, ...content];
  }

  return `${XTALPI_TOOL_POLICY}`;
}

function injectXtalpiToolPolicy(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const policyTargetIndex = messages.findIndex((message) => {
    if (typeof message !== "object" || message === null || !("role" in message)) {
      return false;
    }
    const role = (message as { role?: unknown }).role;
    return role === "system" || role === "developer";
  });

  if (policyTargetIndex < 0) {
    return [{ role: "system", content: XTALPI_TOOL_POLICY }, ...messages];
  }

  return messages.map((message, index) => {
    if (index !== policyTargetIndex || typeof message !== "object" || message === null) {
      return message;
    }

    return {
      ...message,
      content: appendPolicyToContent((message as { content?: unknown }).content),
    };
  });
}

function payloadContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block !== "object" || block === null || !("text" in block)) {
        return "";
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function hasRecoveryPrompt(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    const text = payloadContentText((message as { content?: unknown }).content);
    return (
      text.includes(RECOVERY_PROMPT_MARKER) ||
      text.includes("上一轮 xtalpi 返回了空 assistant 内容")
    );
  });
}

function injectXtalpiRecoveryNoToolsPolicy(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const policyTargetIndex = messages.findIndex((message) => {
    if (typeof message !== "object" || message === null || !("role" in message)) {
      return false;
    }
    const role = (message as { role?: unknown }).role;
    return role === "system" || role === "developer";
  });

  if (policyTargetIndex < 0) {
    return [{ role: "system", content: XTALPI_RECOVERY_NO_TOOLS_POLICY }, ...messages];
  }

  return messages.map((message, index) => {
    if (index !== policyTargetIndex || typeof message !== "object" || message === null) {
      return message;
    }

    const content = (message as { content?: unknown }).content;
    const contentText = payloadContentText(content);
    return contentText.includes(XTALPI_RECOVERY_NO_TOOLS_POLICY_MARKER)
      ? message
      : {
          ...message,
          content:
            typeof content === "string"
              ? `${XTALPI_RECOVERY_NO_TOOLS_POLICY}\n\n${content}`
              : [{ type: "text", text: XTALPI_RECOVERY_NO_TOOLS_POLICY }, ...(Array.isArray(content) ? content : [])],
        };
  });
}

function latestToolResultMirrorExcerpt(messages: unknown, maxChars = 1800): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const text = payloadContentText((message as { content?: unknown }).content);
    const markerIndex = text.lastIndexOf(XTALPI_TOOL_RESULT_MIRROR_MARKER);
    if (markerIndex < 0) {
      continue;
    }
    const excerpt = text.slice(markerIndex).trim();
    return excerpt.length > maxChars
      ? `${excerpt.slice(0, maxChars)}\n[truncated by xtalpi-compat fallback]`
      : excerpt;
  }

  return undefined;
}

function looksSensitiveForFallback(text: string): boolean {
  return /(api[_-]?key|authorization|bearer\s+[a-z0-9._-]+|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)/i.test(
    text,
  );
}

function formatFallbackToolExcerpt(excerpt: string): string | undefined {
  if (!includeFallbackToolExcerpt() || looksSensitiveForFallback(excerpt)) {
    return undefined;
  }

  return excerpt.replace(/```/g, "'''");
}

function collectToolCallNames(messages: unknown[]): Map<string, string> {
  const toolNamesById = new Map<string, string>();

  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }

    const msg = message as {
      tool_calls?: unknown;
      content?: unknown;
    };

    if (Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        if (typeof toolCall !== "object" || toolCall === null) {
          continue;
        }

        const call = toolCall as {
          id?: unknown;
          function?: { name?: unknown };
        };
        if (typeof call.id === "string" && typeof call.function?.name === "string") {
          toolNamesById.set(call.id, call.function.name);
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) {
          continue;
        }

        const contentBlock = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
        };
        if (
          contentBlock.type === "toolCall" &&
          typeof contentBlock.id === "string" &&
          typeof contentBlock.name === "string"
        ) {
          toolNamesById.set(contentBlock.id, contentBlock.name);
        }
      }
    }
  }

  return toolNamesById;
}

function annotateToolResultNames(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const toolNamesById = collectToolCallNames(messages);
  if (toolNamesById.size === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (typeof message !== "object" || message === null) {
      return message;
    }

    const msg = message as {
      role?: unknown;
      tool_call_id?: unknown;
      name?: unknown;
    };

    if (
      msg.role !== "tool" ||
      typeof msg.tool_call_id !== "string" ||
      typeof msg.name === "string"
    ) {
      return message;
    }

    const toolName = toolNamesById.get(msg.tool_call_id);
    return toolName ? { ...message, name: toolName } : message;
  });
}

function removeReasoningContentFromAssistantHistory(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "assistant" ||
      !("reasoning_content" in message)
    ) {
      return message;
    }

    const { reasoning_content: _reasoningContent, ...rest } = message as Record<string, unknown>;
    return rest;
  });
}

function hasToolHistory(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some((message) => {
      if (typeof message !== "object" || message === null) {
        return false;
      }

      const msg = message as { role?: unknown; tool_calls?: unknown };
      return msg.role === "tool" || (msg.role === "assistant" && Array.isArray(msg.tool_calls));
    })
  );
}

function toolResultMirrorText(message: Record<string, unknown>): string {
  const toolName = typeof message.name === "string" ? message.name : "unknown";
  const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "unknown";
  const content = payloadContentText(message.content);
  const maxChars = maxMirroredToolResultChars();
  const truncated =
    content.length > maxChars
      ? `${content.slice(0, maxChars)}\n[truncated by xtalpi-compat: original tool result was ${content.length} chars]`
      : content;

  return `${XTALPI_TOOL_RESULT_MIRROR_MARKER}
tool_name: ${toolName}
tool_call_id: ${toolCallId}
status: tool_result
content:
${truncated}`;
}

function mirrorToolResultsAsUserMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const nextMessages: unknown[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "tool"
    ) {
      nextMessages.push(message);
      continue;
    }

    const toolMessages: Record<string, unknown>[] = [];
    while (
      index < messages.length &&
      typeof messages[index] === "object" &&
      messages[index] !== null &&
      (messages[index] as { role?: unknown }).role === "tool"
    ) {
      const toolMessage = messages[index] as Record<string, unknown>;
      nextMessages.push(toolMessage);
      toolMessages.push(toolMessage);
      index += 1;
    }
    index -= 1;

    nextMessages.push({
      role: "user",
      content: toolMessages.map(toolResultMirrorText).join("\n\n"),
    });
  }

  return nextMessages;
}

function hasSuccessfulReadResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  const toolNamesById = collectToolCallNames(messages);

  return messages.some((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    const msg = message as {
      role?: unknown;
      tool_call_id?: unknown;
      name?: unknown;
      content?: unknown;
    };

    const toolName =
      typeof msg.name === "string"
        ? msg.name
        : typeof msg.tool_call_id === "string"
          ? toolNamesById.get(msg.tool_call_id)
          : undefined;

    if (msg.role !== "tool" || toolName !== "read") {
      return false;
    }

    const text = payloadContentText(msg.content).trim();
    if (text.length < 80) {
      return false;
    }

    return !/(no such file|not found|enoent|is a directory|不存在|未找到|没有这个文件)/i.test(text);
  });
}

function isReadOnlySummaryPrompt(prompt: string): boolean {
  return READ_ONLY_SUMMARY_RE.test(prompt) && !WRITE_OR_BUILD_INTENT_RE.test(prompt);
}

function injectXtalpiReadResultPolicy(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const policyTargetIndex = messages.findIndex((message) => {
    if (typeof message !== "object" || message === null || !("role" in message)) {
      return false;
    }
    const role = (message as { role?: unknown }).role;
    return role === "system" || role === "developer";
  });

  if (policyTargetIndex < 0) {
    return [{ role: "system", content: XTALPI_READ_RESULT_POLICY }, ...messages];
  }

  return messages.map((message, index) => {
    if (index !== policyTargetIndex || typeof message !== "object" || message === null) {
      return message;
    }

    const content = (message as { content?: unknown }).content;
    const contentText = payloadContentText(content);
    return contentText.includes(XTALPI_READ_RESULT_POLICY_MARKER)
      ? message
      : {
          ...message,
          content:
            typeof content === "string"
              ? `${XTALPI_READ_RESULT_POLICY}\n\n${content}`
              : [{ type: "text", text: XTALPI_READ_RESULT_POLICY }, ...(Array.isArray(content) ? content : [])],
        };
  });
}

function sanitizeXtalpiPayload(payload: unknown, latestUserPrompt: string, provider: unknown): unknown {
  if (!isXtalpiPayload(payload, provider)) {
    return undefined;
  }

  let messages = injectXtalpiToolPolicy(payload.messages);
  messages = annotateToolResultNames(messages);
  messages = removeReasoningContentFromAssistantHistory(messages);
  if (shouldMirrorToolResults(messages)) {
    messages = mirrorToolResultsAsUserMessages(messages);
  }
  const recoveryRequest = hasRecoveryPrompt(messages);
  const strategy = emptyAssistantStrategy();

  const nextPayload: ProviderPayload = {
    ...payload,
    messages,
  };

  let filteredTools = filterXtalpiTools(payload.tools, messages, latestUserPrompt);
  if (strategy === "rescue_no_tools" && recoveryRequest) {
    nextPayload.messages = injectXtalpiRecoveryNoToolsPolicy(nextPayload.messages);

    // After xtalpi has already returned an empty assistant, retrying with tools
    // often repeats the same stalled continuation. The rescue turn is text-only.
    delete nextPayload.tools;
    delete nextPayload.tool_choice;
    delete nextPayload.parallel_tool_calls;
    nextPayload.stream = false;
    filteredTools = { ...filteredTools, tools: undefined, keptNames: [] };
  } else {
    nextPayload.tools = filteredTools.tools;
  }

  const hasTools = Array.isArray(nextPayload.tools) && nextPayload.tools.length > 0;
  if (hasTools) {
    // xtalpi's OpenAI-compatible proxy is much more stable when tool calls are
    // serialized. This is provider-level, so it applies to every Pi tool.
    nextPayload.parallel_tool_calls = false;
  }

  if (hasTools || hasToolHistory(messages)) {
    // The proxy currently returns zero usage anyway, and include_usage has
    // correlated with streams ending without a finish_reason after tool use.
    delete nextPayload.stream_options;

    // DeepSeek reasoning parameters work on the official endpoint, but this
    // company proxy is unstable when reasoning and tool continuation mix.
    delete nextPayload.thinking;
    delete nextPayload.reasoning_effort;
  }

  if (recoveryRequest) {
    delete nextPayload.stream_options;
    delete nextPayload.thinking;
    delete nextPayload.reasoning_effort;
  }

  if (hasSuccessfulReadResult(messages) && isReadOnlySummaryPrompt(latestUserPrompt)) {
    nextPayload.messages = injectXtalpiReadResultPolicy(nextPayload.messages);
  }

  debugLog("before_provider_request", {
    provider: typeof provider === "string" ? provider : "unknown",
    model: typeof payload.model === "string" ? payload.model : "unknown",
    toolCount: filteredTools.originalCount,
    filteredToolCount: Array.isArray(nextPayload.tools) ? nextPayload.tools.length : 0,
    keptTools: filteredTools.keptNames,
    toolFilterMode: toolFilterMode(),
    maxTools: maxXtalpiTools(),
    emptyAssistantStrategy: strategy,
    recoveryRequest,
    rescueNoTools: strategy === "rescue_no_tools" && recoveryRequest,
    hasToolHistory: hasToolHistory(messages),
    mirrorMode: toolResultMirrorMode(),
    mirrorCount: countToolResultMirrors(nextPayload.messages),
    stream: nextPayload.stream,
    parallelToolCalls: nextPayload.parallel_tool_calls,
    hasStreamOptions: "stream_options" in nextPayload,
    hasThinking: "thinking" in nextPayload,
    hasReasoningEffort: "reasoning_effort" in nextPayload,
    roles: summarizeRoles(nextPayload.messages),
  });

  return nextPayload;
}

function rewriteLiteLLMAlias(
  message: AssistantMessage,
  providerToolNames: string[],
  activeToolNames: string[],
): AssistantMessage | undefined {
  const availableProviderTools = uniqueToolNames(providerToolNames);
  const availableActiveTools = uniqueToolNames(activeToolNames);
  const availableTools = uniqueToolNames([...availableProviderTools, ...availableActiveTools]);
  let changed = false;
  const content = (message.content ?? []).map((block) => {
    if (block.type !== "toolCall" || block.name !== "litellm_unnamed_tool_0") {
      return block;
    }

    const args = block.arguments;
    const replacementName =
      inferToolNameFromArguments(args, availableTools) ??
      (availableProviderTools.length === 1 ? availableProviderTools[0] : undefined) ??
      (availableActiveTools.length === 1 ? availableActiveTools[0] : undefined);

    if (replacementName) {
      changed = true;
      return { ...block, name: replacementName };
    }

    return block;
  });

  return changed ? { ...message, content } : undefined;
}

function serializeSiblingToolCalls(message: AssistantMessage): AssistantMessage | undefined {
  let seenToolCall = false;
  let changed = false;
  const content = (message.content ?? []).filter((block) => {
    if (block.type !== "toolCall") {
      return true;
    }

    if (!seenToolCall) {
      seenToolCall = true;
      return true;
    }

    changed = true;
    return false;
  });

  return changed ? { ...message, content } : undefined;
}

export default function xtalpiCompat(pi: ExtensionAPI) {
  let activeToolNames: string[] = [];
  let activeProvider: string | undefined;
  let lastProviderToolNames: string[] = [];
  let lastNonAssistantKey: string | undefined;
  let lastQueuedEmptyAssistantKey: string | undefined;
  let hiddenRecoveryCount = 0;
  let turnHiddenRecoveryCount = 0;
  let latestUserPrompt = "";
  let latestToolExcerpt: string | undefined;

  pi.on("before_agent_start", async (event, ctx) => {
    activeProvider = ctx.model?.provider;
    latestUserPrompt = event.prompt ?? "";
    activeToolNames = (event.systemPromptOptions.selectedTools ?? [])
      .map(getToolName)
      .filter((name): name is string => !!name);
    lastProviderToolNames = [];
    lastQueuedEmptyAssistantKey = undefined;
    hiddenRecoveryCount = 0;
    turnHiddenRecoveryCount = 0;
    latestToolExcerpt = undefined;

    debugLog("before_agent_start", {
      provider: activeProvider ?? "unknown",
      model: ctx.model?.id ?? "unknown",
      selectedToolCount: activeToolNames.length,
      selectedTools: activeToolNames,
      emptyAssistantStrategy: emptyAssistantStrategy(),
      mirrorMode: toolResultMirrorMode(),
      maxMirroredToolResultChars: maxMirroredToolResultChars(),
      maxTools: maxXtalpiTools(),
    });
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const sanitized = sanitizeXtalpiPayload(event.payload, latestUserPrompt, ctx.model?.provider ?? activeProvider);
    if (sanitized && typeof sanitized === "object") {
      lastProviderToolNames = payloadToolNames((sanitized as ProviderPayload).tools);
      latestToolExcerpt =
        latestToolResultMirrorExcerpt((sanitized as ProviderPayload).messages) ?? latestToolExcerpt;
    }
    return sanitized;
  });

  pi.on("context", async (event) => {
    const messages = event.messages ?? [];
    let latestRecoveryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isRecoveryMessage(messages[index])) {
        latestRecoveryIndex = index;
        break;
      }
    }

    const filtered = messages.filter((msg, index) => {
      if (isEmptyXtalpiAssistant(msg)) {
        return false;
      }

      // Keep only the newest hidden recovery prompt. Older ones are session
      // bookkeeping and should not keep polluting future provider payloads.
      if (isRecoveryMessage(msg) && index !== latestRecoveryIndex) {
        return false;
      }

      return true;
    });

    return filtered.length === messages.length ? undefined : { messages: filtered };
  });

  pi.on("message_end", async (event) => {
    const message = event.message as AssistantMessage;

    if (message.role !== "assistant") {
      lastNonAssistantKey = messageKey(event.message);
      if (message.role === "user") {
        lastQueuedEmptyAssistantKey = undefined;
        hiddenRecoveryCount = 0;
        turnHiddenRecoveryCount = 0;
        latestToolExcerpt = undefined;
      }
      return;
    }

    if (!isXtalpiProvider(message.provider)) {
      return;
    }

    const rewritten = rewriteLiteLLMAlias(message, lastProviderToolNames, activeToolNames);
    const serialized = serializeSiblingToolCalls(rewritten ?? message);
    const nextMessage = serialized ?? rewritten ?? message;

    if (hasActionableContent(nextMessage)) {
      lastQueuedEmptyAssistantKey = undefined;
      hiddenRecoveryCount = 0;
      if (rewritten) {
        debugLog("litellm_alias_rewritten", {
          provider: message.provider ?? "unknown",
          model: message.model ?? "unknown",
          providerTools: lastProviderToolNames,
          activeTools: activeToolNames,
        });
      }
      if (serialized) {
        debugLog("sibling_tool_calls_serialized", {
          provider: message.provider ?? "unknown",
          model: message.model ?? "unknown",
        });
      }
      return rewritten || serialized ? { message: nextMessage } : undefined;
    }

    if (
      nextMessage.stopReason === "stop" ||
      nextMessage.stopReason === "toolUse" ||
      isRecoverableXtalpiStreamError(nextMessage)
    ) {
      const emptyAssistantKey = messageKey(nextMessage) ?? lastNonAssistantKey;
      const recoverableMessage: AssistantMessage = {
        ...nextMessage,
        stopReason: "stop",
        errorMessage: undefined,
      };
      const strategy = emptyAssistantStrategy();

      if (
        strategy !== "fail_fast" &&
        emptyAssistantKey !== lastQueuedEmptyAssistantKey &&
        hiddenRecoveryCount < MAX_HIDDEN_RECOVERIES &&
        turnHiddenRecoveryCount < MAX_HIDDEN_RECOVERIES_PER_TURN
      ) {
        lastQueuedEmptyAssistantKey = emptyAssistantKey;
        hiddenRecoveryCount += 1;
        turnHiddenRecoveryCount += 1;
        pi.sendMessage(
          {
            customType: RECOVERY_CUSTOM_TYPE,
            content: RECOVERY_PROMPT,
            display: false,
            details: { attempt: hiddenRecoveryCount, turnAttempt: turnHiddenRecoveryCount },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        debugLog("hidden_recovery_queued", {
          provider: message.provider ?? "unknown",
          model: message.model ?? "unknown",
          attempt: hiddenRecoveryCount,
          turnAttempt: turnHiddenRecoveryCount,
          emptyAssistantStrategy: strategy,
          stopReason: nextMessage.stopReason,
        });
        return { message: recoverableMessage };
      }

      debugLog("hidden_recovery_exhausted", {
        provider: message.provider ?? "unknown",
        model: message.model ?? "unknown",
        emptyAssistantStrategy: strategy,
        stopReason: nextMessage.stopReason,
      });
      return { message: recoveryFallbackMessage(recoverableMessage, latestToolExcerpt) };
    }

    return rewritten ? { message: nextMessage } : undefined;
  });
}
