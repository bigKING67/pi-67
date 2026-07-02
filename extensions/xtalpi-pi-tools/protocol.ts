export const PROVIDER_ID = "xtalpi-pi-tools";
export const API_ID = "xtalpi-pi-tools";
export const PROVIDER_NAME = "XtalPi Pi Tools";

export const DEFAULT_BASE_URL = "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1";

export const TOOL_CALL_OPEN = "<pi_tool_call>";
export const TOOL_CALL_CLOSE = "</pi_tool_call>";
export const TOOL_RESULT_OPEN = "<pi_tool_result>";
export const TOOL_RESULT_CLOSE = "</pi_tool_result>";
export const TOOL_CALL_HISTORY_OPEN = "<pi_tool_call_history>";
export const TOOL_CALL_HISTORY_CLOSE = "</pi_tool_call_history>";

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

export const PROTOCOL_SYSTEM_PROMPT = `You are running inside Pi as a coding agent.

Pi owns all local tools. The xtalpi endpoint only sees plain chat text, so you MUST NOT use native OpenAI tool calls.

If you need exactly one tool, reply with exactly this envelope and no extra prose:

${TOOL_CALL_OPEN}
{"name":"tool_name","arguments":{"arg":"value"}}
${TOOL_CALL_CLOSE}

Tool protocol rules:
- Emit at most one ${TOOL_CALL_OPEN} envelope per assistant turn.
- The envelope JSON must have exactly two top-level fields: "name" and "arguments".
- "name" must match one available tool name exactly.
- "arguments" must be a JSON object.
- Do not invent tools. Do not use OpenAI tool_calls, function_call, role=tool, or markdown tables for tool invocation.
- After Pi returns ${TOOL_RESULT_OPEN}, read that result directly and produce a normal final answer unless another single tool call is strictly necessary.
- Do not repeat the same tool call after its result has already been returned.
- If no tool is needed, answer normally without any tool envelope.`;
