import {
  DEFAULT_MAX_EMPTY_RETRIES,
  DEFAULT_MAX_REPAIR_RETRIES,
  DEFAULT_MAX_TOTAL_RECOVERIES,
} from "../protocol.ts";

const DECIMAL_INTEGER = /^[+-]?\d+$/;

export function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim();
  if (!DECIMAL_INTEGER.test(normalized)) return fallback;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value >= min ? value : fallback;
}

// Compatibility getters for older local extensions. RuntimePolicy owns active recovery limits.
export function maxEmptyRetries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES", DEFAULT_MAX_EMPTY_RETRIES, 0);
}

export function maxRepairRetries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES", DEFAULT_MAX_REPAIR_RETRIES, 0);
}

export function maxTotalRecoveries(): number {
  return envInt("XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES", DEFAULT_MAX_TOTAL_RECOVERIES, 0);
}
