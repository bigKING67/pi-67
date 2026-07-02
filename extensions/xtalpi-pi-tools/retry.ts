import {
  DEFAULT_MAX_EMPTY_RETRIES,
  DEFAULT_MAX_REPAIR_RETRIES,
  DEFAULT_MAX_TOTAL_RECOVERIES,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
} from "./protocol.ts";

export function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export function maxEmptyRetries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES", DEFAULT_MAX_EMPTY_RETRIES, 0);
}

export function maxRepairRetries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES", DEFAULT_MAX_REPAIR_RETRIES, 0);
}

export function maxTotalRecoveries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES", DEFAULT_MAX_TOTAL_RECOVERIES, 0);
}

export function buildEmptyResponseRepairPrompt(): string {
  return `[xtalpi-pi-tools-empty-response-repair]
The previous response was empty. You must now produce either:
1. a normal non-empty final answer, or
2. exactly one <pi_tool_call> JSON envelope if a tool is strictly necessary.

Do not return an empty assistant message.`;
}

export function buildInvalidToolJsonRepairPrompt(errorMessage: string, raw: string): string {
  return `[xtalpi-pi-tools-invalid-tool-json-repair]
Your previous tool-call envelope could not be parsed:
${errorMessage}

Previous raw output excerpt:
${raw.slice(0, 2000)}

Return either a normal final answer, or exactly one valid envelope:
<pi_tool_call>
{"name":"tool_name","arguments":{}}
</pi_tool_call>`;
}

export function buildFunctionStyleToolRepairPrompt(raw: string, availableNames: string[]): string {
  const names = availableNames.slice(0, 80).join(", ") || "(none)";
  return `[xtalpi-pi-tools-function-style-tool-repair]
Your previous response looked like a function-style tool call, which Pi cannot execute:
${raw.slice(0, 2000)}

Available tool names:
${names}

Do not return JavaScript/Python-style tool calls such as tool_name({...}).
If a tool is still necessary, return exactly one valid Pi tool envelope and no extra prose:
${TOOL_CALL_OPEN}
{"name":"tool_name","arguments":{}}
${TOOL_CALL_CLOSE}

If no available tool fits, return a normal final answer.`;
}

export function buildUnknownToolRepairPrompt(toolName: string, availableNames: string[]): string {
  const names = availableNames.slice(0, 80).join(", ") || "(none)";
  return `[xtalpi-pi-tools-unknown-tool-repair]
The tool name "${toolName}" is not available in this Pi turn.

Available tool names:
${names}

Return a normal final answer if no available tool fits. Otherwise return exactly one valid <pi_tool_call> envelope using one available name.`;
}

export function buildRepeatedToolRepairPrompt(toolName: string): string {
  return `[xtalpi-pi-tools-repeated-tool-repair]
You already received the result for the same "${toolName}" tool call.
Read the existing <pi_tool_result> block and produce the final answer now.
Do not repeat the same tool call.`;
}
