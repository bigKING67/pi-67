import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_DEBUG_PATH = join(process.env.HOME || "/tmp", "tmp", "xtalpi-pi-tools-debug.jsonl");
const DEBUG_QUEUE_LIMIT = 512;
const DEBUG_FLUSH_BATCH_SIZE = 32;
const DEBUG_FLUSH_INTERVAL_MS = 250;
const SENSITIVE_DATA_KEY = /^(?:x[_-]?api[_-]?key|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|cookie|session(?:[_-]?id)?|secret|private[_-]?key)$/i;

type DebugQueueItem = {
  file: string;
  line: string;
};

const debugQueue: DebugQueueItem[] = [];
let debugFlushTimer: ReturnType<typeof setTimeout> | undefined;
let debugFlushPromise: Promise<void> | undefined;
let debugFlushScheduled = false;
let debugDroppedCount = 0;
let beforeExitHookInstalled = false;

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
    const raw = JSON.stringify(data, (key, value) => {
      if (key && SENSITIVE_DATA_KEY.test(key)) {
        return typeof value === "string" && /^Bearer\s+/i.test(value)
          ? redactSensitiveString(value)
          : "[REDACTED]";
      }
      return typeof value === "string" ? redactSensitiveString(value) : value;
    });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return { serialization_error: safeErrorMessage(error) };
  }
}

function installBeforeExitHook(): void {
  if (beforeExitHookInstalled) return;
  beforeExitHookInstalled = true;
  process.once("beforeExit", () => {
    void flushDebugLogs();
  });
}

function scheduleDebugFlush(): void {
  installBeforeExitHook();
  if (debugQueue.length >= DEBUG_FLUSH_BATCH_SIZE) {
    if (debugFlushScheduled) return;
    debugFlushScheduled = true;
    queueMicrotask(() => {
      debugFlushScheduled = false;
      void flushDebugLogs();
    });
    return;
  }
  if (debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    debugFlushTimer = undefined;
    void flushDebugLogs();
  }, DEBUG_FLUSH_INTERVAL_MS);
  debugFlushTimer.unref?.();
}

function enqueueDebugLine(item: DebugQueueItem): void {
  if (debugQueue.length >= DEBUG_QUEUE_LIMIT) {
    debugQueue.shift();
    debugDroppedCount += 1;
  }
  debugQueue.push(item);
  scheduleDebugFlush();
}

async function appendDebugBatch(batch: DebugQueueItem[]): Promise<void> {
  const linesByFile = new Map<string, string[]>();
  for (const item of batch) {
    const lines = linesByFile.get(item.file) ?? [];
    lines.push(item.line);
    linesByFile.set(item.file, lines);
  }
  await Promise.all(
    [...linesByFile.entries()].map(async ([file, lines]) => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, lines.join(""), "utf8");
      } catch {
        // Diagnostics must never affect the provider flow.
      }
    }),
  );
}

export async function flushDebugLogs(): Promise<void> {
  debugFlushScheduled = false;
  if (debugFlushPromise) {
    await debugFlushPromise;
    if (debugQueue.length > 0) return flushDebugLogs();
    return;
  }
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = undefined;
  }
  if (debugQueue.length === 0) return;

  const batch = debugQueue.splice(0, DEBUG_QUEUE_LIMIT);
  debugFlushPromise = appendDebugBatch(batch);
  try {
    await debugFlushPromise;
  } finally {
    debugFlushPromise = undefined;
  }
  if (debugQueue.length > 0) await flushDebugLogs();
}

export function debugQueueSnapshot(): {
  queued: number;
  dropped: number;
  limit: number;
} {
  return {
    queued: debugQueue.length,
    dropped: debugDroppedCount,
    limit: DEBUG_QUEUE_LIMIT,
  };
}

export function debugLog(event: string, data: Record<string, unknown>): void {
  if (!envFlag("XTALPI_PI_TOOLS_DEBUG")) return;
  const file = process.env.XTALPI_PI_TOOLS_DEBUG_PATH || DEFAULT_DEBUG_PATH;
  const [eventCategory, ...eventKindParts] = event.split(".");
  const safeData = sanitizeData(data);

  try {
    const line = `${JSON.stringify({
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
        runtime_profile: stringField(safeData, "runtimeProfile"),
        runtime_engine: stringField(safeData, "runtimeEngine"),
        compatibility_protocol_version: stringField(safeData, "compatibilityProtocolVersion"),
        tool_selection_clipped: booleanField(safeData, "toolSelectionClipped"),
        tool_selection_omitted_count: numberField(safeData, "toolSelectionOmittedCount"),
        tool_selection_valid_count: numberField(safeData, "toolSelectionValidCount"),
        tool_selection_prompt_source: stringField(safeData, "toolSelectionPromptSource"),
        tool_selection_prompt_chars: numberField(safeData, "toolSelectionPromptChars"),
        tool_selection_user_messages: numberField(safeData, "toolSelectionUserMessageCount"),
        max_tool_result_chars: numberField(safeData, "maxToolResultChars"),
        max_tool_history_chars: numberField(safeData, "maxToolHistoryChars"),
        tool_history_chars: numberField(safeData, "toolHistoryChars"),
        tool_history_omitted_count: numberField(safeData, "toolHistoryOmittedCount"),
        tool_result_receipt_version: stringField(safeData, "toolResultReceiptVersion"),
        max_output_tokens: numberField(safeData, "maxOutputTokens"),
        request_timeout_ms: numberField(safeData, "requestTimeoutMs"),
        per_attempt_timeout_ms: numberField(safeData, "perAttemptTimeoutMs"),
        total_request_deadline_ms: numberField(safeData, "totalRequestDeadlineMs"),
        remaining_ms: numberField(safeData, "remainingMs"),
        elapsed_ms: numberField(safeData, "elapsedMs"),
        body_bytes: numberField(safeData, "bodyBytes"),
        max_response_bytes: numberField(safeData, "maxResponseBytes"),
        attempt: numberField(safeData, "attempt"),
        attempt_count: numberField(safeData, "attemptCount"),
        retry_count: numberField(safeData, "retryCount"),
        retry_delay_ms: numberField(safeData, "retryDelayMs"),
        retry_delay_source: stringField(safeData, "retryDelaySource"),
        retry_suppressed_reason: stringField(safeData, "retrySuppressedReason"),
        max_empty_retries: numberField(safeData, "maxEmptyRetries"),
        max_repair_retries: numberField(safeData, "maxRepairRetries"),
        max_total_recoveries: numberField(safeData, "maxTotalRecoveries"),
        max_format_recoveries: numberField(safeData, "maxFormatRecoveries"),
        max_final_recoveries: numberField(safeData, "maxFinalRecoveries"),
        max_repeated_call_recoveries: numberField(safeData, "maxRepeatedCallRecoveries"),
        diagnostics_dropped_count: debugDroppedCount,
        error_code: stringField(safeData, "errorCode"),
        error_category: stringField(safeData, "errorCategory"),
        retryable: booleanField(safeData, "retryable"),
        http_status: numberField(safeData, "httpStatus"),
        argument_validation_warning_count: numberField(safeData, "argumentValidationWarningCount"),
        argument_validation_warning_codes: stringArrayField(safeData, "argumentValidationWarningCodes"),
        data: safeData,
      })}\n`;
    enqueueDebugLine({ file, line });
  } catch {
    // Diagnostics must never affect the provider flow.
  }
}
