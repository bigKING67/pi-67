export type VisionToolKind = "semantic" | "review";

export type VisionTaskDetection = {
  isVisionTask: boolean;
  hasImagePath: boolean;
  hasImageIntent: boolean;
  hasImageContent: boolean;
  imagePaths: string[];
  reasonCodes: string[];
};

export type VisionToolRoute = {
  name: string;
  kind: VisionToolKind;
  priority: number;
};

type ToolNameLike = {
  name: string;
};

type MessageLike = {
  role: string;
  content?: unknown;
};

type ContentBlock = Record<string, unknown>;

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "svg",
];

const IMAGE_EXTENSION_PATTERN = IMAGE_EXTENSIONS.join("|");
const IMAGE_PATH_PATTERN = new RegExp(
  [
    `"([^"\\r\\n]*\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^"\\r\\n]*)?)"`,
    `'([^'\\r\\n]*\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^'\\r\\n]*)?)'`,
    "`([^`\\r\\n]*\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^`\\r\\n]*)?)`",
    `((?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|/|\\\\\\\\|[^\\s"'<>]*?(?:pi|codex)-clipboard-)[^\\s"'<>]*\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^\\s"'<>]*)?)`,
  ].join("|"),
  "gi",
);

const VISUAL_UNDERSTANDING_INTENT_PATTERN =
  /(?:看图|读图|识图|识别图片|识别截图|图片识别|截图识别|分析图片|分析截图|解析图片|解析截图|图片内容|截图内容|图里|图中|图上|这张图|这张图片|这个截图|OCR|ocr|视觉|多模态|image\s+(?:analysis|understanding|description|ocr)|screenshot\s+(?:analysis|understanding|description|ocr)|(?:analy[sz]e|inspect|describe|read|ocr)\s+(?:this\s+)?(?:image|screenshot|picture)|what(?:'s| is)\s+(?:in|on)\s+(?:this\s+)?(?:image|screenshot|picture))/i;

const CURRENT_IMAGE_REFERENCE_PATTERN =
  /(?:这张图|这张图片|这个图|这个图片|这个截图|这张截图|上面(?:的)?图|上面(?:的)?截图|刚才(?:的)?图|刚才(?:的)?截图|附件(?:图片|截图)?|attached\s+(?:image|screenshot|picture)|this\s+(?:image|screenshot|picture)|current\s+(?:image|screenshot|picture))/i;

const IMAGE_CONTENT_MARKER_PATTERN =
  /\[image omitted:\s*xtalpi-pi-tools is text-only\b/i;

const IMAGE_OUTPUT_OR_MUTATION_PATTERN =
  /(?:生成|画一张|绘制|文生图|图生图|改图|修图|换背景|换风格|保存为|输出到|删除|移动|复制|重命名|上传|download|upload|delete|remove|rename|move|copy|save as|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|draw\s+(?:an?\s+)?image|edit\s+(?:the\s+)?image)/i;

const CONTINUATION_PROMPT_PATTERN = new RegExp(
  "^\\s*(?:继续上一轮|继续上一步|继续(?:呀|吧)?|接着(?:来|吧)?|下一步|然后呢|再来|往下|go on|continue|next|proceed)(?:\\s|$|[，。,.!！?？])",
  "i",
);

const VISION_INABILITY_FINAL_PATTERN =
  /(?:(?:无法|不能|不支持|没法|没有能力|看不到|无法实际处理|无法解析|无法读取|纯文本|text-only|text only|can't|cannot|unable|not able|do not have)\s*[\s\S]{0,140}(?:图片|截图|图像|照片|image|screenshot|picture|vision)|(?:图片|截图|图像|照片|image|screenshot|picture)\s*[\s\S]{0,140}(?:无法|不能|不支持|看不到|无法实际处理|无法解析|纯文本|text-only|text only|can't|cannot|unable|not able)|(?:请|麻烦|please)\s*[\s\S]{0,80}(?:描述|提供|粘贴|describe)\s*[\s\S]{0,80}(?:图片|截图|image|screenshot|picture))/i;

const SEMANTIC_VISION_TOOL_NAMES = [
  "vision_read",
  "image_analyze",
  "image_ocr",
  "ocr_image",
  "image_to_text",
];

const REVIEW_VISION_TOOL_NAMES = [
  "image_review",
];

export const VISION_TOOL_NAMES = [
  ...SEMANTIC_VISION_TOOL_NAMES,
  ...REVIEW_VISION_TOOL_NAMES,
];

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function contentBlockReference(block: ContentBlock): string | undefined {
  for (const key of ["path", "file", "image", "url", "image_url", "data", "src"]) {
    const value = block[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const source = block.source;
  if (typeof source === "string" && source.trim()) return source.trim();
  if (typeof source === "object" && source !== null) {
    const sourceRecord = source as Record<string, unknown>;
    for (const key of ["path", "file", "url", "image_url", "data"]) {
      const value = sourceRecord[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }

  return undefined;
}

export function imageContentBlockToText(block: ContentBlock): string {
  const ref = contentBlockReference(block);
  if (ref) {
    const safeRef = ref.length > 500 ? `${ref.slice(0, 500)}...` : ref;
    return `[image omitted: xtalpi-pi-tools is text-only; Pi must route image tasks through a local vision bridge before asking this text model. image_ref=${safeRef}]`;
  }
  return "[image omitted: xtalpi-pi-tools is text-only; Pi must route image tasks through a local vision bridge before asking this text model.]";
}

function contentToVisionText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const item = block as ContentBlock;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "image") return imageContentBlockToText(item);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserVisionText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return contentToVisionText(message.content);
  }
  return "";
}

function recentUserVisionText(messages: readonly MessageLike[]): string {
  const chunks: string[] = [];
  for (let index = messages.length - 1; index >= 0 && chunks.length < 4; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = contentToVisionText(message.content).trim();
    if (text) chunks.push(text);
  }
  return chunks.reverse().join("\n");
}

export function visionTaskPromptText(messages: readonly MessageLike[] | undefined): string {
  const safeMessages = messages ?? [];
  const latest = latestUserVisionText(safeMessages);
  if (CONTINUATION_PROMPT_PATTERN.test(latest.trim())) {
    return recentUserVisionText(safeMessages) || latest;
  }
  return latest;
}

export function extractImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of String(text || "").matchAll(IMAGE_PATH_PATTERN)) {
    const candidate = match.slice(1).find((value) => typeof value === "string" && value.trim());
    if (!candidate) continue;
    paths.push(candidate.trim().replace(/[),.;，。；]+$/u, ""));
  }
  return unique(paths);
}

export function detectVisionTaskText(text: string): VisionTaskDetection {
  const safeText = String(text || "");
  const imagePaths = extractImagePaths(safeText);
  const hasImagePath = imagePaths.length > 0;
  const hasImageIntent = VISUAL_UNDERSTANDING_INTENT_PATTERN.test(safeText);
  const hasCurrentImageReference = CURRENT_IMAGE_REFERENCE_PATTERN.test(safeText);
  const hasImageContent = IMAGE_CONTENT_MARKER_PATTERN.test(safeText);
  const hasOutputOrMutationIntent = IMAGE_OUTPUT_OR_MUTATION_PATTERN.test(safeText);
  const isVisionTask = hasImageContent || (hasImagePath && !hasOutputOrMutationIntent) || (hasImageIntent && hasCurrentImageReference);
  const reasonCodes: string[] = [];

  if (hasImagePath) reasonCodes.push("prompt_image_path");
  if (hasImageIntent) reasonCodes.push("prompt_image_intent");
  if (hasImageContent) reasonCodes.push("prompt_image_content");
  if (isVisionTask) reasonCodes.push("vision_bridge_task");

  return {
    isVisionTask,
    hasImagePath,
    hasImageIntent,
    hasImageContent,
    imagePaths,
    reasonCodes,
  };
}

export function detectVisionTaskInMessages(messages: readonly MessageLike[] | undefined): VisionTaskDetection {
  return detectVisionTaskText(visionTaskPromptText(messages));
}

export function visionToolRouteForName(name: string): VisionToolRoute | undefined {
  const semanticIndex = SEMANTIC_VISION_TOOL_NAMES.indexOf(name);
  if (semanticIndex >= 0) {
    return { name, kind: "semantic", priority: 100 - semanticIndex };
  }

  const reviewIndex = REVIEW_VISION_TOOL_NAMES.indexOf(name);
  if (reviewIndex >= 0) {
    return { name, kind: "review", priority: 10 - reviewIndex };
  }

  return undefined;
}

export function preferredVisionToolName(tools: readonly ToolNameLike[] | undefined): string | undefined {
  return [...(tools ?? [])]
    .map((tool) => visionToolRouteForName(tool.name))
    .filter((route): route is VisionToolRoute => route !== undefined)
    .sort((left, right) => right.priority - left.priority)[0]?.name;
}

export function selectedVisionToolName(selectedToolNames: Iterable<string>): string | undefined {
  return [...selectedToolNames]
    .map((name) => visionToolRouteForName(name))
    .filter((route): route is VisionToolRoute => route !== undefined)
    .sort((left, right) => right.priority - left.priority)[0]?.name;
}

export function isVisionInabilityFinal(text: string): boolean {
  return VISION_INABILITY_FINAL_PATTERN.test(String(text || ""));
}

export function visionToolArguments(toolName: string, detection: VisionTaskDetection, latestUserText: string): Record<string, unknown> {
  const image = detection.imagePaths[0] ?? "";
  const prompt = latestUserText.trim() || "请读取并分析这张图片，提取关键文字、视觉内容和与用户任务相关的信息。";

  if (toolName === "image_review") {
    return {
      image,
      title: "Pi vision bridge",
      question: "请确认这张图片，并补充需要 Pi 关注的关键点。",
      context: prompt,
      allow_feedback: true,
    };
  }

  return {
    image,
    prompt,
  };
}

export function buildVisionBridgeToolCallRepairPrompt(input: {
  toolName: string;
  detection: VisionTaskDetection;
  latestUserText: string;
}): string {
  const args = visionToolArguments(input.toolName, input.detection, input.latestUserText);
  return `[xtalpi-pi-tools-vision-bridge-tool-call-repair]
The user request is an image/screenshot understanding task. xtalpi-pi-tools is text-only, so you must not answer that you cannot see images and must not call read for image files.

Return exactly one compact JSON action object and no markdown/prose:
${JSON.stringify({ kind: "tool_call", name: input.toolName, arguments: args })}

After Pi returns the tool result, use that text evidence to answer the user.`;
}

export function buildVisionBridgeReadinessFinal(input: {
  detection: VisionTaskDetection;
  availableToolNames: readonly string[];
  selectedToolNames: readonly string[];
  maxTools: number;
  preferredToolName?: string;
}): string {
  const imageList = input.detection.imagePaths.length > 0
    ? input.detection.imagePaths.map((item) => `- ${item}`).join("\n")
    : "- (未从当前 prompt 中解析到可直接传给工具的图片路径；可能是内联图片块)";
  const availableVisionNames = input.availableToolNames.filter((name) => VISION_TOOL_NAMES.includes(name));
  const reason = input.preferredToolName
    ? `本机存在视觉工具 ${input.preferredToolName}，但它没有进入本轮 selected-tool 白名单；当前 XTALPI_PI_TOOLS_MAX_TOOLS=${input.maxTools}。`
    : `本轮 Pi runtime 没有注册任何可用视觉工具：${VISION_TOOL_NAMES.join(", ")}。`;

  return [
    "检测到图片/截图理解任务，但 Pi 本地 vision bridge 当前未 ready，已在本地停止，避免把图片路径误交给 read 后产生假成功。",
    "",
    `原因：${reason}`,
    "",
    "已识别的图片输入：",
    imageList,
    "",
    "解决方式：",
    "1. 运行 `pi-67 update --repair` 后重启 Pi，确认 `vision_read` 或 `image_review` 出现在工具列表。",
    "2. 运行 `pi-67 doctor` / `pi-67 xtalpi capability` 检查本地配置。",
    "3. 如果只是临时处理图片，可切换到支持 image input 的多模态 provider/model。",
    "",
    "这个错误是 readiness gate，不是晶泰文本模型的最终回答；晶泰仍只负责普通文本，图片理解必须先由 Pi 本地视觉桥接转换成文本证据。",
  ].join("\n");
}
