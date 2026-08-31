/**
 * Adaptive next-scan scheduling for discovery companies.
 * Deterministic pure helpers — no I/O.
 */

export type ScanPriority = "manual" | "hot" | "high" | "normal" | "inactive";

export type ErrorCategory =
  | "rate_limit"
  | "timeout"
  | "not_found"
  | "server_error"
  | "network"
  | "validation"
  | "llm_quota"
  | "ssrf_blocked"
  | "unknown";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Base interval by priority when the last scan succeeded. */
export const SUCCESS_INTERVAL_MS: Record<ScanPriority, number> = {
  /** Manual override still waits 1h after success to avoid tight claim loops. */
  manual: HOUR_MS,
  hot: 6 * HOUR_MS,
  high: 24 * HOUR_MS,
  normal: 5 * DAY_MS,
  inactive: 30 * DAY_MS,
};

export const MAX_BACKOFF_MS = 30 * DAY_MS;
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export function successIntervalMs(priority: ScanPriority): number {
  return SUCCESS_INTERVAL_MS[priority] ?? SUCCESS_INTERVAL_MS.normal;
}

/**
 * Exponential backoff: min(max, base * 2^(failures-1)).
 * failures=1 → 1h, 2 → 2h, 3 → 4h, … capped at 30d.
 */
export function failureBackoffMs(consecutiveFailures: number): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const base = HOUR_MS;
  const ms = base * 2 ** (failures - 1);
  return Math.min(MAX_BACKOFF_MS, ms);
}

export function computeNextEligibleAt(input: {
  priority: ScanPriority;
  now?: Date;
  success?: boolean;
  consecutiveFailures?: number;
  forceImmediate?: boolean;
}): Date {
  const now = input.now ?? new Date();
  if (input.forceImmediate) {
    return now;
  }
  if (input.success) {
    return new Date(now.getTime() + successIntervalMs(input.priority));
  }
  const failures = input.consecutiveFailures ?? 1;
  return new Date(now.getTime() + failureBackoffMs(failures));
}

export function isLeaseStale(
  leaseExpiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!leaseExpiresAt) return true;
  const expires =
    leaseExpiresAt instanceof Date ? leaseExpiresAt : new Date(leaseExpiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() <= now.getTime();
}

export function classifyHttpError(status: number | null | undefined): ErrorCategory {
  if (status == null) return "network";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server_error";
  if (status >= 400) return "validation";
  return "unknown";
}
