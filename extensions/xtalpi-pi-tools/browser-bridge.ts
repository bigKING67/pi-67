import type { ToolLike } from "./tools/types.ts";

export type BrowserMcpDetection = {
  isBrowserMcpTask: boolean;
  reasonCodes: string[];
};

export type BrowserMcpReadinessInput = {
  detection: BrowserMcpDetection;
  availableToolNames: readonly string[];
  selectedToolNames: readonly string[];
  maxTools: number;
  preferredToolName?: string;
};

const BROWSER_TOOL_NAME_PATTERN = /\b(?:browser67|tmwd_browser|tmwd-browser|chrome|edge|browser|cdp)\b/i;
const MANAGED_BROWSER_TOOL_NAME_PATTERN = /\b(?:browser67|tmwd_browser|tmwd-browser|cdp)\b/i;
const MCP_GATEWAY_NAME_PATTERN = /\bmcp\b/i;
const BROWSER_CN_SPECIFIC_PATTERN = /(?:真实\s*浏览器|当前\s*(?:标签页|页面)|新\s*标签页|网页\s*截图|页面\s*截图|登录态|登陆态|抓包|开发者工具)/i;
const BROWSER_CN_SURFACE_ACTION_PATTERN =
  /(?:(?:打开|访问)\s*(?:网页|网站|链接|页面|浏览器|chrome|edge)|(?:点击|输入|上传|下载|滚动|截图|截屏|登录|登陆|抓包).{0,24}(?:网页|页面|标签页|浏览器|chrome|edge|表单|控制台|开发者工具)|(?:网页|页面|标签页|浏览器|chrome|edge|表单|控制台|开发者工具).{0,24}(?:点击|输入|上传|下载|滚动|截图|截屏|登录|登陆|抓包))/i;
const BROWSER_TOOL_THEN_CN_ACTION_PATTERN =
  /(?:browser67|tmwd_browser|tmwd-browser|chrome|edge|浏览器).{0,32}(?:打开|访问|点击|输入|上传|下载|滚动|截图|截屏|登录|登陆|抓包|控制台|开发者工具)/i;
const BROWSER_ACTION_PATTERN = /\b(?:open|navigate|visit|browse|click|type|login|log\s*in|sign\s*in|upload|download|screenshot|tab|current\s+page|current\s+tab|cookie|session|dom|network|console|devtools|inspect)\b/i;
const BROWSER_STRONG_ACTION_PATTERN =
  /(?:(?:screenshot|screen\s*shot).{0,48}(?:current\s+)?(?:page|tab|browser|website)|current\s+(?:page|tab)|browser\s+(?:page|tab|console|session)|network\s+panel|devtools)/i;
const URL_OPEN_PATTERN = /(?:打开|访问|open|navigate|visit|browse).{0,80}https?:\/\//i;
const URL_SCREENSHOT_PATTERN =
  /(?:(?:screenshot|screen\s*shot|capture|截图|截屏).{0,100}https?:\/\/|https?:\/\/.{0,100}(?:screenshot|screen\s*shot|capture|截图|截屏))/i;
const NON_BROWSER_IMPLEMENTATION_PATTERN =
  /(?:源码|源代码|代码|组件|配置(?:文件)?|静态资源|项目|仓库|测试|脚本|文档附件|知识库|source\s+code|compatib(?:ility|le)|component|config(?:uration)?|project|repository|test|script|schema|database|queue)/i;
const NEGATIVE_BROWSER_PATTERN = /(?:不要|不用|禁止|无需|别).{0,24}(?:browser67|tmwd_browser|浏览器|chrome|edge)|(?:do\s+not|don't|dont|without|no)\s+(?:use\s+)?(?:browser67|tmwd_browser|browser|chrome|edge)/i;
const NEGATIVE_DEFAULT_BROWSER_PATTERN =
  /(?:不要|不用|禁止|无需|别).{0,32}(?:系统默认浏览器|默认浏览器|Safari|macOS\s*open|bash\s*open|shell\s*open|普通\s*浏览器)|(?:do\s+not|don't|dont|without|no).{0,32}(?:default\s+browser|Safari|macOS\s+open|bash\s+open|shell\s+open)/i;

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
  if (NEGATIVE_BROWSER_PATTERN.test(text) && !NEGATIVE_DEFAULT_BROWSER_PATTERN.test(text)) {
    reasonCodes.add("prompt_browser_forbidden");
    return { isBrowserMcpTask: false, reasonCodes: [...reasonCodes].sort() };
  }

  const hasToolName = BROWSER_TOOL_NAME_PATTERN.test(text);
  const hasManagedToolName = MANAGED_BROWSER_TOOL_NAME_PATTERN.test(text);
  const hasMcpGatewayName = MCP_GATEWAY_NAME_PATTERN.test(text);
  const hasImplementationContext = NON_BROWSER_IMPLEMENTATION_PATTERN.test(text);
  const hasChineseBrowserIntent = BROWSER_CN_SPECIFIC_PATTERN.test(text) ||
    (BROWSER_CN_SURFACE_ACTION_PATTERN.test(text) && !hasImplementationContext);
  const hasChineseToolThenAction = BROWSER_TOOL_THEN_CN_ACTION_PATTERN.test(text) &&
    (!hasImplementationContext || hasManagedToolName);
  const hasAction = BROWSER_ACTION_PATTERN.test(text);
  const hasStrongAction = BROWSER_STRONG_ACTION_PATTERN.test(text);
  const hasUrlOpen = URL_OPEN_PATTERN.test(text);
  const hasUrlScreenshot = URL_SCREENSHOT_PATTERN.test(text);

  if (hasToolName) reasonCodes.add("prompt_browser_tool_name");
  if (hasMcpGatewayName) reasonCodes.add("prompt_mcp_gateway_name");
  if (hasChineseBrowserIntent) reasonCodes.add("prompt_browser_cn_intent");
  if (hasChineseToolThenAction) reasonCodes.add("prompt_browser_cn_tool_then_action");
  if (hasAction) reasonCodes.add("prompt_browser_action");
  if (hasStrongAction) reasonCodes.add("prompt_browser_strong_action");
  if (hasUrlOpen) reasonCodes.add("prompt_browser_url_open");
  if (hasUrlScreenshot) reasonCodes.add("prompt_browser_url_screenshot");

  const isBrowserMcpTask = hasUrlOpen || hasUrlScreenshot || hasChineseBrowserIntent || hasChineseToolThenAction ||
    hasStrongAction || (hasToolName && hasAction && (!hasImplementationContext || hasManagedToolName));
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

export function selectedBrowserMcpToolName(selectedToolNames: Iterable<string>): string | undefined {
  for (const name of selectedToolNames) {
    if (browserMcpToolRouteForName(name)) return name;
  }
  return undefined;
}

export function buildBrowserMcpReadinessFinal(input: BrowserMcpReadinessInput): string {
  const available = input.availableToolNames.length > 0 ? input.availableToolNames.join(", ") : "(none)";
  const selected = input.selectedToolNames.length > 0 ? input.selectedToolNames.join(", ") : "(none)";
  const preferred = input.preferredToolName || "(none)";
  const reasons = input.detection.reasonCodes.length > 0 ? input.detection.reasonCodes.join(", ") : "(none)";

  return [
    "xtalpi-pi-tools 检测到这是 browser67/tmwd_browser 真实浏览器任务，但本轮没有可执行 browser MCP 工具被选中。",
    "",
    `browser task reason codes: ${reasons}`,
    `available tools: ${available}`,
    `selected tools: ${selected}`,
    `preferred browser tool: ${preferred}`,
    `max tools: ${input.maxTools}`,
    "",
    "为避免错误降级到 macOS `open`、Safari、系统默认浏览器或普通 shell 浏览器操作，本轮已拒绝继续使用 bash/open 代替 browser67。",
    "请确认 `pi-mcp-adapter` 已加载且 `mcp` 工具可用，然后重试；需要快速验证可运行 `bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-smoke.sh --case mcp-connect-tmwd-browser`。",
  ].join("\n");
}
