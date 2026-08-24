/**
 * Pure discovery-source rotation helpers (no I/O).
 *
 * Cursor / retry rules (documented for MCP consumers):
 * - claim_next_discovery_source claims the current enabled cursor source.
 * - Only one non-stale claimed run may exist globally (enforced by partial unique index).
 * - Stale claims (older than timeout) consume one attempt. Below max attempts the
 *   stale run is failed and the same source is reclaimed (attempt_number + 1).
 *   At max attempts the stale run becomes skipped_after_failures, the cursor
 *   advances, and claim_next claims the next enabled source in the same call.
 * - complete_discovery_source always advances to the next enabled source,
 *   even when qualified_count is 0, and resets that source's failure count.
 * - After the last enabled source, cycle_id increments, failure counts reset,
 *   and cursor returns to the first enabled source.
 * - fail_discovery_source increments consecutive failures for the source in the
 *   current cycle. Below DISCOVERY_SOURCE_MAX_ATTEMPTS (default 3): cursor stays,
 *   retry_required=true. At the limit: run status=skipped_after_failures,
 *   cursor advances, retry_required=false, auto_advanced=true.
 */

export const DEFAULT_DISCOVERY_SOURCES = [
  { source_key: "ashby", display_name: "Ashby", source_order: 1, enabled: true },
  { source_key: "greenhouse", display_name: "Greenhouse", source_order: 2, enabled: true },
  { source_key: "lever", display_name: "Lever", source_order: 3, enabled: true },
  { source_key: "workday", display_name: "Workday", source_order: 4, enabled: true },
  {
    source_key: "company_careers",
    display_name: "Company careers pages",
    source_order: 5,
    enabled: true,
  },
] as const;

export type DiscoverySourceKey = (typeof DEFAULT_DISCOVERY_SOURCES)[number]["source_key"];

export type DiscoverySourceRecord = {
  source_key: string;
  display_name: string;
  source_order: number;
  enabled: boolean;
};

export type DiscoveryRunStatus =
  | "claimed"
  | "completed"
  | "failed"
  | "skipped_after_failures";

export const DEFAULT_CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
export const MIN_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CLAIM_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MIN_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 100;

export const DEFAULT_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const MAX_CHECKPOINT_MAX_BYTES = 256 * 1024;

export const STORED_ERROR_MAX_LEN = 2000;

export function getClaimTimeoutMs(): number {
  const raw = process.env.DISCOVERY_SOURCE_CLAIM_TIMEOUT_MINUTES?.trim();
  if (!raw) return DEFAULT_CLAIM_TIMEOUT_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_CLAIM_TIMEOUT_MS;
  const ms = Math.floor(minutes) * 60 * 1000;
  return Math.min(MAX_CLAIM_TIMEOUT_MS, Math.max(MIN_CLAIM_TIMEOUT_MS, ms));
}

export function getMaxAttempts(): number {
  const raw = process.env.DISCOVERY_SOURCE_MAX_ATTEMPTS?.trim();
  if (!raw) return DEFAULT_MAX_ATTEMPTS;
  const attempts = Number(raw);
  if (!Number.isFinite(attempts) || attempts < MIN_MAX_ATTEMPTS) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_MAX_ATTEMPTS, Math.floor(attempts));
}

export function getCheckpointMaxBytes(): number {
  const raw = process.env.DISCOVERY_SOURCE_CHECKPOINT_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_CHECKPOINT_MAX_BYTES;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_CHECKPOINT_MAX_BYTES;
  return Math.min(MAX_CHECKPOINT_MAX_BYTES, Math.floor(bytes));
}

export function sanitizeDiscoveryError(
  error: string,
  maxLen: number = STORED_ERROR_MAX_LEN,
): string {
  let text = String(error || "unknown error").replace(/\s+/g, " ").trim();
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[REDACTED_JWT]");
  text = text.replace(
    /(client_secret|client-secret|password|api[_-]?key|token)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
  text = text.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DB_URL]");
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return text || "unknown error";
}

export function assertCheckpointSize(checkpoint: Record<string, unknown>): void {
  const serialized = JSON.stringify(checkpoint);
  const maxBytes = getCheckpointMaxBytes();
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(
      `checkpoint exceeds maximum size of ${maxBytes} bytes (${Buffer.byteLength(serialized, "utf8")} bytes)`,
    );
  }
}

export type DiscoveryRunCounters = {
  discovered_count: number;
  preflight_skipped_count: number;
  evaluated_count: number;
  qualified_count: number;
  submitted_count: number;
};

export function assertCounterChain(counters: DiscoveryRunCounters): void {
  const {
    discovered_count,
    preflight_skipped_count,
    evaluated_count,
    qualified_count,
    submitted_count,
  } = counters;
  if (preflight_skipped_count > discovered_count) {
    throw new Error("preflight_skipped_count cannot exceed discovered_count");
  }
  if (evaluated_count > discovered_count) {
    throw new Error("evaluated_count cannot exceed discovered_count");
  }
  if (qualified_count > evaluated_count) {
    throw new Error("qualified_count cannot exceed evaluated_count");
  }
  if (submitted_count > qualified_count) {
    throw new Error("submitted_count cannot exceed qualified_count");
  }
}

export function listEnabledSourcesOrdered(
  sources: DiscoverySourceRecord[],
): DiscoverySourceRecord[] {
  return sources
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) => a.source_order - b.source_order || a.source_key.localeCompare(b.source_key));
}

export function advanceDiscoveryCursor(
  sources: DiscoverySourceRecord[],
  currentSourceKey: string,
  cycleId: number,
): { nextSourceKey: string; nextCycleId: number; wrapped: boolean } {
  const enabled = listEnabledSourcesOrdered(sources);
  if (!enabled.length) {
    throw new Error("No enabled discovery sources configured");
  }

  const currentIndex = enabled.findIndex((s) => s.source_key === currentSourceKey);
  if (currentIndex < 0) {
    return {
      nextSourceKey: enabled[0].source_key,
      nextCycleId: cycleId,
      wrapped: false,
    };
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex >= enabled.length) {
    return {
      nextSourceKey: enabled[0].source_key,
      nextCycleId: cycleId + 1,
      wrapped: true,
    };
  }

  return {
    nextSourceKey: enabled[nextIndex].source_key,
    nextCycleId: cycleId,
    wrapped: false,
  };
}

export function isClaimStale(
  startedAt: string | Date,
  now: Date = new Date(),
  timeoutMs: number = getClaimTimeoutMs(),
): boolean {
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(started.getTime())) return true;
  return now.getTime() - started.getTime() >= timeoutMs;
}

export function parseFailureCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
  }
  return out;
}

export function incrementFailureCount(
  counts: Record<string, number>,
  sourceKey: string,
): Record<string, number> {
  return { ...counts, [sourceKey]: (counts[sourceKey] ?? 0) + 1 };
}

export function resetFailureCountForSource(
  counts: Record<string, number>,
  sourceKey: string,
): Record<string, number> {
  if (!(sourceKey in counts)) return counts;
  const next = { ...counts };
  delete next[sourceKey];
  return next;
}

export function clearFailureCounts(): Record<string, number> {
  return {};
}

export function shouldSkipAfterFailure(
  failureCount: number,
  maxAttempts: number = getMaxAttempts(),
): boolean {
  return failureCount >= maxAttempts;
}
