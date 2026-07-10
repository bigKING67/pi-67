import { imageContentBlockToText } from "../vision-bridge.ts";

export type ContentBlock = Record<string, unknown>;

export type MessageLike = {
  role: string;
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const item = block as ContentBlock;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "image") return imageContentBlockToText(item);
      if (item.type === "thinking" || item.type === "toolCall") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
