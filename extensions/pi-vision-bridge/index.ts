import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_CHARS = 12_000;
const VISION_DEADLINE_MS = 120_000;

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

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length > 200;
}

async function resolveImageInput(
  image: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ imageUrl: string; sourceLabel: string }> {
  const trimmed = image.trim();
  if (!trimmed) throw new Error("vision_read image is required");
  if (looksLikeUrl(trimmed)) {
    const response = await fetch(trimmed, {
      method: "GET",
      headers: { accept: "image/*" },
      redirect: "follow",
      signal,
    });
    if (!response.ok) throw new Error(`vision_read image download failed with HTTP ${response.status}`);
    const bytes = await readResponseBytesBounded(response, MAX_LOCAL_IMAGE_BYTES, "vision_read image download");
    const mime = sniffImageMime(bytes);
    return { imageUrl: dataUrl(mime, bytes), sourceLabel: safeUrlLabel(trimmed) };
  }
  if (looksLikeDataUrl(trimmed)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(trimmed);
    if (!match?.[1] || !match[2]) throw new Error("vision_read image data URL is invalid");
    const bytes = decodeBase64Bounded(match[2]);
    const mime = sniffImageMime(bytes);
    if (normalizeMime(match[1]) !== normalizeMime(mime)) {
      throw new Error(`vision_read image data URL MIME does not match detected ${mime}`);
    }
    return { imageUrl: dataUrl(mime, bytes), sourceLabel: `data-url:${mime}` };
  }
  if (looksLikeBase64(trimmed)) {
    const bytes = decodeBase64Bounded(trimmed);
    const mime = sniffImageMime(bytes);
    return { imageUrl: dataUrl(mime, bytes), sourceLabel: `base64:${mime}` };
  }

  const workspace = realpathSync.native(resolve(cwd));
  const candidate = isAbsolute(trimmed) ? trimmed : resolve(workspace, trimmed);
  if (!existsSync(candidate)) throw new Error(`vision_read image file not found: ${trimmed}`);
  const file = realpathSync.native(candidate);
  const workspaceRelative = relative(workspace, file);
  if (workspaceRelative === ".." || workspaceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(workspaceRelative)) {
    throw new Error("vision_read local image must resolve inside the active workspace");
  }
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error("vision_read local image must be a regular file");
  if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`vision_read image file is too large: ${stat.size} bytes > ${MAX_LOCAL_IMAGE_BYTES}`);
  }
  const bytes = readFileSync(file);
  const mime = sniffImageMime(bytes);
  return { imageUrl: dataUrl(mime, bytes), sourceLabel: file };
}

function decodeBase64Bounded(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("vision_read image base64 is invalid");
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((normalized.length * 3) / 4) - padding;
  if (estimatedBytes > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`vision_read image is too large: ${estimatedBytes} bytes > ${MAX_LOCAL_IMAGE_BYTES}`);
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`vision_read image is too large: ${bytes.byteLength} bytes > ${MAX_LOCAL_IMAGE_BYTES}`);
  }
  return bytes;
}

function sniffImageMime(bytes: Uint8Array): string {
  const ascii = Buffer.from(bytes.subarray(0, 512)).toString("ascii");
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("BM")) return "image/bmp";
  if (bytes.length >= 4 && (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )) return "image/tiff";
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12).toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  const text = Buffer.from(bytes.subarray(0, 4096)).toString("utf8").replace(/^\uFEFF?\s*/, "");
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return "image/svg+xml";
  throw new Error("vision_read image content is not a supported image format");
}

function normalizeMime(value: string): string {
  const normalized = value.toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function safeUrlLabel(value: string): string {
  const parsed = new URL(value);
  const pathname = parsed.pathname.length > 300 ? `${parsed.pathname.slice(0, 297)}...` : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${pathname}`;
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
    ...(signal ? { signal } : {}),
  });
  const text = Buffer.from(
    await readResponseBytesBounded(response, MAX_PROVIDER_RESPONSE_BYTES, "vision provider response"),
  ).toString("utf8");
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

async function readResponseBytesBounded(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new Error(`${label} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`vision_read timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
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
      "兼容性视觉桥接工具。仅当当前模型或 provider 无法原生接收图片时，用它读取图片/截图并返回文本证据；原生多模态模型应直接接收图片，或用 read 读取本地图片。适合 text-only provider 的 OCR、截图报错分析和图片内容理解 fallback。",
    parameters: VISION_READ_PARAMS,
    async execute(_toolCallId, rawParams, signal: AbortSignal | undefined, onUpdate, ctx) {
      const params = rawParams as VisionReadParams;
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
      const config = resolveProviderConfig();
      const deadline = deadlineSignal(signal, VISION_DEADLINE_MS);
      const prompt = (params.prompt?.trim() || DEFAULT_PROMPT).slice(0, MAX_PROMPT_CHARS);
      const detail = ["low", "high", "auto"].includes(params.detail || "") ? String(params.detail) : "auto";
      const maxOutputChars = clampMaxOutputChars(params.max_output_chars);

      try {
        const { imageUrl, sourceLabel } = await resolveImageInput(params.image || "", cwd, deadline.signal);

        onUpdate?.({
          content: [{ type: "text", text: `vision_read: analyzing image with ${config.provider}/${config.model}...` }],
          details: { provider: config.provider, model: config.model, image: sourceLabel },
        });

        const text = await callVisionModel({
          config,
          imageUrl,
          prompt,
          detail,
          signal: deadline.signal,
        });
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
      } finally {
        deadline.dispose();
      }
    },
  });
}
