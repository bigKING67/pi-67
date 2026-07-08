import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_DEBUG_PATH = join(process.env.HOME || "/tmp", "tmp", "xtalpi-pi-tools-debug.jsonl");

export function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._~+\-/=]{8,}/g, "sk-[REDACTED]")
    .replace(
      /(^|[^A-Za-z0-9_])((?:x[_-]?api[_-]?key|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|cookie|session(?:[_-]?id)?)(?:["'\s]*[:=]\s*|["'\s]+))([A-Za-z0-9._~+\-/=:%;,@]+)/gi,
      "$1$2[REDACTED]",
    );
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveString(message);
}

function stringField(data: Record<string, unknown>, name: string): string | undefined {
  const value = data[name];
  return typeof value === "string" ? value : undefined;
}

function numberField(data: Record<string, unknown>, name: string): number | undefined {
  const value = data[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(data: Record<string, unknown>, name: string): boolean | undefined {
  const value = data[name];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayField(data: Record<string, unknown>, name: string): string[] | undefined {
  const value = data[name];
  if (!Array.isArray(value)) return undefined;
  return value.map(String).filter(Boolean).slice(0, 16);
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const raw = JSON.stringify(data);
    if (!raw) return {};
    const parsed = JSON.parse(redactSensitiveString(raw));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return { serialization_error: safeErrorMessage(error) };
  }
}

export function debugLog(event: string, data: Record<string, unknown>): void {
  if (!envFlag("XTALPI_PI_TOOLS_DEBUG")) return;
  const file = process.env.XTALPI_PI_TOOLS_DEBUG_PATH || DEFAULT_DEBUG_PATH;
  const [eventCategory, ...eventKindParts] = event.split(".");
  const safeData = sanitizeData(data);

  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({
        schema: "xtalpi-pi-tools.debug.v1",
        ts: new Date().toISOString(),
        event,
        event_category: eventCategory || "event",
        event_kind: eventKindParts.join(".") || event,
        provider: stringField(safeData, "provider"),
        model: stringField(safeData, "model"),
        protocol_version: stringField(safeData, "protocolVersion"),
        action_protocol: stringField(safeData, "actionProtocol"),
        response_format: stringField(safeData, "responseFormat"),
        tool_name: stringField(safeData, "toolName"),
        repair_retries: numberField(safeData, "repairRetries"),
        total_recoveries: numberField(safeData, "totalRecoveries"),
        selected_tool_count: numberField(safeData, "selectedToolCount"),
        selected_tool_names_hash: stringField(safeData, "selectedToolNamesHash"),
        available_tool_count: numberField(safeData, "availableToolCount"),
        max_tools: numberField(safeData, "maxTools"),
        tool_selection_clipped: booleanField(safeData, "toolSelectionClipped"),
        tool_selection_omitted_count: numberField(safeData, "toolSelectionOmittedCount"),
        tool_selection_valid_count: numberField(safeData, "toolSelectionValidCount"),
        tool_selection_prompt_source: stringField(safeData, "toolSelectionPromptSource"),
        tool_selection_prompt_chars: numberField(safeData, "toolSelectionPromptChars"),
        tool_selection_user_messages: numberField(safeData, "toolSelectionUserMessageCount"),
        max_tool_result_chars: numberField(safeData, "maxToolResultChars"),
        max_output_tokens: numberField(safeData, "maxOutputTokens"),
        request_timeout_ms: numberField(safeData, "requestTimeoutMs"),
        attempt: numberField(safeData, "attempt"),
        attempt_count: numberField(safeData, "attemptCount"),
        retry_count: numberField(safeData, "retryCount"),
        retry_delay_ms: numberField(safeData, "retryDelayMs"),
        retry_suppressed_reason: stringField(safeData, "retrySuppressedReason"),
        max_empty_retries: numberField(safeData, "maxEmptyRetries"),
        max_repair_retries: numberField(safeData, "maxRepairRetries"),
        max_total_recoveries: numberField(safeData, "maxTotalRecoveries"),
        error_code: stringField(safeData, "errorCode"),
        error_category: stringField(safeData, "errorCategory"),
        retryable: booleanField(safeData, "retryable"),
        http_status: numberField(safeData, "httpStatus"),
        argument_validation_warning_count: numberField(safeData, "argumentValidationWarningCount"),
        argument_validation_warning_codes: stringArrayField(safeData, "argumentValidationWarningCodes"),
        data: safeData,
      })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never affect the provider flow.
  }
}
