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
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+\-/=]{8,}/gi, "$1[REDACTED]")
    .replace(/(authorization["'\s:=]+)[A-Za-z0-9._~+\-/=]{8,}/gi, "$1[REDACTED]");
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
        tool_name: stringField(safeData, "toolName"),
        repair_retries: numberField(safeData, "repairRetries"),
        total_recoveries: numberField(safeData, "totalRecoveries"),
        selected_tool_count: numberField(safeData, "selectedToolCount"),
        selected_tool_names_hash: stringField(safeData, "selectedToolNamesHash"),
        available_tool_count: numberField(safeData, "availableToolCount"),
        max_tools: numberField(safeData, "maxTools"),
        max_tool_result_chars: numberField(safeData, "maxToolResultChars"),
        max_output_tokens: numberField(safeData, "maxOutputTokens"),
        request_timeout_ms: numberField(safeData, "requestTimeoutMs"),
        max_empty_retries: numberField(safeData, "maxEmptyRetries"),
        max_repair_retries: numberField(safeData, "maxRepairRetries"),
        max_total_recoveries: numberField(safeData, "maxTotalRecoveries"),
        error_code: stringField(safeData, "errorCode"),
        error_category: stringField(safeData, "errorCategory"),
        retryable: booleanField(safeData, "retryable"),
        http_status: numberField(safeData, "httpStatus"),
        data: safeData,
      })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never affect the provider flow.
  }
}
