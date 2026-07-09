import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type VisionReadParams = {
  image?: string;
  prompt?: string;
  detail?: "low" | "high" | "auto" | string;
  max_output_chars?: number;
};

type ProviderConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
};

const DEFAULT_PROVIDER = "codex";
const DEFAULT_PROMPT =
  "请用中文读取并分析这张图片。优先提取可见文字/OCR、关键对象、界面状态、报错信息、表格字段和与用户任务相关的证据。不要编造看不清的细节。";
const DEFAULT_MAX_OUTPUT_CHARS = 6000;
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

const VISION_READ_PARAMS = {
  type: "object",
  required: ["image"],
  additionalProperties: false,
  properties: {
    image: {
      type: "string",
      description: "要读取的图片：本地路径、URL、data URL 或 base64。截图/剪贴板图片通常是 pi-clipboard-*.png 路径。",
    },
    prompt: {
      type: "string",
      description: "可选视觉任务说明，例如 OCR、截图报错分析、表格字段提取。",
    },
    detail: {
      type: "string",
      enum: ["low", "high", "auto"],
      description: "可选图像细节级别；默认 auto。",
    },
    max_output_chars: {
      type: "number",
      description: "返回文本最大字符数，默认 6000。",
    },
  },
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.cwd(), ".pi", "agent");
}

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveProviderConfig(): ProviderConfig {
  const envBaseUrl = stringValue(process.env.PI67_VISION_BASE_URL);
  const envApiKey = stringValue(process.env.PI67_VISION_API_KEY);
  const envProvider = stringValue(process.env.PI67_VISION_PROVIDER);
  const envModel = stringValue(process.env.PI67_VISION_MODEL);

  if (envBaseUrl && envApiKey && envModel) {
    return {
      provider: envProvider || "env",
      model: envModel,
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
    };
  }

  const modelsFile = join(agentDir(), "models.json");
  if (!existsSync(modelsFile)) {
    throw new Error(`vision_read cannot find models.json at ${modelsFile}`);
  }

  const parsed = readJsonFile(modelsFile) as Record<string, unknown>;
  const providers = parsed && typeof parsed.providers === "object" && parsed.providers !== null
    ? parsed.providers as Record<string, unknown>
    : {};
  const providerId = envProvider || DEFAULT_PROVIDER;
  const provider = providers[providerId] as Record<string, unknown> | undefined;
  if (!provider || typeof provider !== "object") {
    throw new Error(`vision_read provider '${providerId}' is missing in models.json`);
  }

  const models = Array.isArray(provider.models) ? provider.models as Record<string, unknown>[] : [];
  const model = envModel
    ? models.find((item) => item.id === envModel)
    : models.find((item) => Array.isArray(item.input) && item.input.map(String).includes("image"));
  const modelId = stringValue(envModel || model?.id);
  const baseUrl = stringValue(provider.baseUrl);
  const apiKey = envApiKey || stringValue(provider.apiKey);
  if (!modelId || !baseUrl || !apiKey) {
    throw new Error(`vision_read provider '${providerId}' is not configured with baseUrl/apiKey/image model`);
  }

  return {
    provider: providerId,
    model: modelId,
    baseUrl,
    apiKey,
  };
}

function mimeTypeForPath(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return "image/png";
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length > 200;
}

function resolveImageInput(image: string, cwd: string): { imageUrl: string; sourceLabel: string } {
  const trimmed = image.trim();
  if (!trimmed) throw new Error("vision_read image is required");
  if (looksLikeUrl(trimmed) || looksLikeDataUrl(trimmed)) return { imageUrl: trimmed, sourceLabel: trimmed };
  if (looksLikeBase64(trimmed)) return { imageUrl: `data:image/png;base64,${trimmed.replace(/\s+/g, "")}`, sourceLabel: "base64" };

  const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  if (!existsSync(file)) throw new Error(`vision_read image file not found: ${trimmed}`);
  const buffer = readFileSync(file);
  if (buffer.byteLength > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`vision_read image file is too large: ${buffer.byteLength} bytes > ${MAX_LOCAL_IMAGE_BYTES}`);
  }
  return {
    imageUrl: `data:${mimeTypeForPath(file)};base64,${buffer.toString("base64")}`,
    sourceLabel: file,
  };
}

function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/responses`;
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function outputTextFromResponsesJson(json: unknown): string {
  const record = json as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as Record<string, unknown>[]
      : [];
    for (const block of content) {
      if (typeof block.text === "string") parts.push(block.text);
      if (typeof block.output_text === "string") parts.push(block.output_text);
    }
  }
  return parts.join("\n").trim();
}

function outputTextFromChatJson(json: unknown): string {
  const record = json as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices as Record<string, unknown>[] : [];
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "object" && item !== null ? (item as Record<string, unknown>).text : "")
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .join("\n")
      .trim();
  }
  return "";
}

async function postJson(url: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = typeof (json as Record<string, unknown>)?.error === "object"
      ? JSON.stringify((json as Record<string, unknown>).error)
      : text.slice(0, 500);
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return json;
}

async function callVisionModel(input: {
  config: ProviderConfig;
  imageUrl: string;
  prompt: string;
  detail: string;
  signal?: AbortSignal;
}): Promise<string> {
  const responsesBody = {
    model: input.config.model,
    stream: false,
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: input.prompt },
        { type: "input_image", image_url: input.imageUrl, detail: input.detail },
      ],
    }],
    max_output_tokens: 2048,
  };

  try {
    const json = await postJson(responsesUrl(input.config.baseUrl), input.config.apiKey, responsesBody, input.signal);
    const text = outputTextFromResponsesJson(json);
    if (text) return text;
  } catch (error) {
    if (!/HTTP 404|HTTP 405|not found|method/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }

  const chatBody = {
    model: input.config.model,
    stream: false,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: input.prompt },
        { type: "image_url", image_url: { url: input.imageUrl, detail: input.detail } },
      ],
    }],
    max_tokens: 2048,
  };
  const json = await postJson(chatCompletionsUrl(input.config.baseUrl), input.config.apiKey, chatBody, input.signal);
  const text = outputTextFromChatJson(json);
  if (!text) throw new Error("vision model returned an empty response");
  return text;
}

function clampMaxOutputChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_CHARS;
  return Math.max(1000, Math.min(20000, Math.floor(value)));
}

export default function piVisionBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "vision_read",
    label: "Vision Read",
    description:
      "本地视觉桥接工具。读取图片/截图并返回文本证据，供 text-only provider 使用；适合 OCR、截图报错分析、图片内容理解。图片任务优先调用它，不要用 read 读取 .png/.jpg。",
    promptSnippet:
      "遇到图片、截图、OCR、看图、读图、分析图片路径时，优先调用 vision_read 把图片转成文本证据；xtalpi-pi-tools 是 text-only，不要直接用 read 读取图片。",
    parameters: VISION_READ_PARAMS,
    async execute(_toolCallId, params: VisionReadParams, signal: AbortSignal | undefined, onUpdate, ctx) {
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
      const config = resolveProviderConfig();
      const { imageUrl, sourceLabel } = resolveImageInput(params.image || "", cwd);
      const prompt = params.prompt?.trim() || DEFAULT_PROMPT;
      const detail = params.detail?.trim() || "auto";
      const maxOutputChars = clampMaxOutputChars(params.max_output_chars);

      onUpdate?.({
        content: [{ type: "text", text: `vision_read: analyzing image with ${config.provider}/${config.model}...` }],
        details: { provider: config.provider, model: config.model, image: sourceLabel },
      });

      const text = await callVisionModel({ config, imageUrl, prompt, detail, signal });
      const trimmed = text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}\n\n[vision_read truncated]` : text;

      return {
        content: [{
          type: "text",
          text: [
            "VISION_READ_OK",
            `provider_model: ${config.provider}/${config.model}`,
            `image: ${sourceLabel}`,
            "",
            "analysis:",
            trimmed,
          ].join("\n"),
        }],
        details: {
          provider: config.provider,
          model: config.model,
          image: sourceLabel,
          detail,
        },
      };
    },
  });
}
