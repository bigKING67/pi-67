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

export function debugLog(event: string, data: Record<string, unknown>): void {
  if (!envFlag("XTALPI_PI_TOOLS_DEBUG")) return;
  const file = process.env.XTALPI_PI_TOOLS_DEBUG_PATH || DEFAULT_DEBUG_PATH;

  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        data: JSON.parse(redactSensitiveString(JSON.stringify(data))),
      })}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never affect the provider flow.
  }
}
