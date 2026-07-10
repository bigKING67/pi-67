export class RequestBudget {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly perAttemptTimeoutMs: number;

  constructor(input: {
    perAttemptTimeoutMs: number;
    totalRequestDeadlineMs: number;
    nowMs?: number;
  }) {
    const now = input.nowMs ?? performance.now();
    this.startedAtMs = now;
    this.deadlineAtMs = now + input.totalRequestDeadlineMs;
    this.perAttemptTimeoutMs = input.perAttemptTimeoutMs;
  }

  elapsedMs(nowMs = performance.now()): number {
    return Math.max(0, nowMs - this.startedAtMs);
  }

  remainingMs(nowMs = performance.now()): number {
    return Math.max(0, this.deadlineAtMs - nowMs);
  }

  attemptTimeoutMs(nowMs = performance.now()): number {
    return Math.max(0, Math.min(this.perAttemptTimeoutMs, this.remainingMs(nowMs)));
  }

  canWait(delayMs: number, minimumRemainingMs = 1): boolean {
    return delayMs >= 0 && this.remainingMs() - delayMs >= minimumRemainingMs;
  }
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : undefined;
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}
