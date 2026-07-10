export const PROVIDER_ID = "xtalpi-pi-tools";
export const API_ID = "xtalpi-pi-tools";
export const PROVIDER_NAME = "XtalPi Pi Tools";
export const COMPATIBILITY_PROTOCOL_VERSION = "xtalpi-pi-tools.compat.v2";

export const DEFAULT_BASE_URL = "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1";

export const TOOL_CALL_OPEN = "<pi_tool_call>";
export const TOOL_CALL_CLOSE = "</pi_tool_call>";
export const TOOL_RESULT_OPEN = "<pi_tool_result>";
export const TOOL_RESULT_CLOSE = "</pi_tool_result>";

export const DEFAULT_MAX_TOOLS = 24;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 20000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_TIMEOUT_MS = 180000;
export const DEFAULT_MAX_EMPTY_RETRIES = 2;
export const DEFAULT_MAX_REPAIR_RETRIES = 2;
export const DEFAULT_MAX_TOTAL_RECOVERIES = 4;

export type JsonObject = Record<string, unknown>;

export type PiToolCallEnvelope = {
  name: string;
  arguments: JsonObject;
};

export type XtalpiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type XtalpiChatPayload = {
  model: string;
  messages: XtalpiChatMessage[];
  stream: false;
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" };
};

export type UsageSummary = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

export const EMPTY_USAGE: UsageSummary = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};
