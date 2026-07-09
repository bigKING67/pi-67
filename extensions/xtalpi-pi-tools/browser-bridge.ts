import type { ToolLike } from "./tool-selection.ts";

export type BrowserMcpDetection = {
  isBrowserMcpTask: boolean;
  reasonCodes: string[];
};

const BROWSER_TOOL_NAME_PATTERN = /\b(?:browser67|tmwd_browser|tmwd-browser|chrome|edge|browser|cdp|mcp)\b/i;
const BROWSER_CN_PATTERN = /(?:浏览器|真实\s*浏览器|当前\s*标签页|新\s*标签页|网页\s*截图|页面\s*截图|登录态|登陆态|打开\s*(?:网页|网站|链接|页面|浏览器|chrome|edge)|访问\s*(?:网页|网站|链接|页面)|点击|输入|上传|下载|滚动|抓包|控制台|开发者工具)/i;
const BROWSER_ACTION_PATTERN = /\b(?:open|navigate|visit|browse|click|type|login|log\s*in|sign\s*in|upload|download|screenshot|tab|current\s+page|current\s+tab|cookie|session|dom|network|console|devtools|inspect)\b/i;
const URL_OPEN_PATTERN = /(?:打开|访问|open|navigate|visit|browse).{0,80}https?:\/\//i;
const NEGATIVE_BROWSER_PATTERN = /(?:不要|不用|禁止|无需|别).{0,24}(?:browser67|tmwd_browser|mcp|浏览器|chrome|edge)|(?:do\s+not|don't|dont|without|no)\s+(?:use\s+)?(?:browser67|tmwd_browser|mcp|browser|chrome|edge)/i;

const BROWSER_DIRECT_TOOL_NAMES = new Set([
  "browser_tab_lifecycle",
  "browser_wait",
  "browser_execute_js",
  "browser_screenshot_ops",
  "browser_evidence_bundle_ops",
  "browser_transport_health",
  "browser_run_ops",
  "browser_job_ops",
  "browser_download_ops",
  "browser_file_chooser_ops",
]);

export function detectBrowserMcpTaskText(prompt: string): BrowserMcpDetection {
  const text = String(prompt || "").trim();
  const reasonCodes = new Set<string>();
  if (!text) return { isBrowserMcpTask: false, reasonCodes: [] };
  if (NEGATIVE_BROWSER_PATTERN.test(text)) {
    reasonCodes.add("prompt_browser_forbidden");
    return { isBrowserMcpTask: false, reasonCodes: [...reasonCodes].sort() };
  }

  const hasToolName = BROWSER_TOOL_NAME_PATTERN.test(text);
  const hasChineseBrowserIntent = BROWSER_CN_PATTERN.test(text);
  const hasAction = BROWSER_ACTION_PATTERN.test(text);
  const hasUrlOpen = URL_OPEN_PATTERN.test(text);

  if (hasToolName) reasonCodes.add("prompt_browser_tool_name");
  if (hasChineseBrowserIntent) reasonCodes.add("prompt_browser_cn_intent");
  if (hasAction) reasonCodes.add("prompt_browser_action");
  if (hasUrlOpen) reasonCodes.add("prompt_browser_url_open");

  const isBrowserMcpTask = hasUrlOpen || hasChineseBrowserIntent || (hasToolName && hasAction);
  return { isBrowserMcpTask, reasonCodes: [...reasonCodes].sort() };
}

export function browserMcpToolRouteForName(name: string): "mcp_gateway" | "browser_direct" | undefined {
  const normalized = String(name || "").trim();
  if (normalized === "mcp") return "mcp_gateway";
  if (BROWSER_DIRECT_TOOL_NAMES.has(normalized)) return "browser_direct";
  if (/^(?:tmwd_browser|browser67)[._-]/.test(normalized)) return "browser_direct";
  return undefined;
}

export function preferredBrowserMcpToolName(tools: Iterable<ToolLike>): string | undefined {
  const names = [...tools].map((tool) => tool.name).filter(Boolean);
  if (names.includes("mcp")) return "mcp";
  return names.find((name) => browserMcpToolRouteForName(name) === "browser_direct");
}
