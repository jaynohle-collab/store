/**
 * Shared dashboard list query parameter parsing and URL building.
 */

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 25;

export const TO_APPLY_SORT_OPTIONS = [
  "match",
  "gpt",
  "posted",
  "first_seen",
  "company",
  "title",
] as const;

export type ToApplySort = (typeof TO_APPLY_SORT_OPTIONS)[number];

export const APPLIED_SORT_OPTIONS = ["applied", "company", "title", "status"] as const;

export type AppliedSort = (typeof APPLIED_SORT_OPTIONS)[number];

export const ALL_JOBS_SORT_OPTIONS = ["newest", "posted", "match", "company"] as const;

export type AllJobsSort = (typeof ALL_JOBS_SORT_OPTIONS)[number];

export const REMOTE_FILTER_OPTIONS = ["remote_us", "all"] as const;

export type RemoteFilter = (typeof REMOTE_FILTER_OPTIONS)[number];

/** Maximum server-side dashboard search length (characters). */
export const MAX_DASHBOARD_SEARCH_LENGTH = 200;

/** PostgreSQL ILIKE escape character (must match ESCAPE clause in SQL). */
export const ILIKE_ESCAPE_CHAR = "\\";

/** Trim, collapse whitespace, and cap length; empty → null (show all). */
export function normalizeDashboardSearch(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed.length) return null;
  return trimmed.length > MAX_DASHBOARD_SEARCH_LENGTH
    ? trimmed.slice(0, MAX_DASHBOARD_SEARCH_LENGTH)
    : trimmed;
}

/** Escape ILIKE metacharacters so user % _ \\ are matched literally. */
export function escapeIlikeLiteral(value: string): string {
  return value
    .replace(/\\/g, `${ILIKE_ESCAPE_CHAR}${ILIKE_ESCAPE_CHAR}`)
    .replace(/%/g, `${ILIKE_ESCAPE_CHAR}%`)
    .replace(/_/g, `${ILIKE_ESCAPE_CHAR}_`);
}

/** ILIKE pattern for server-side search (never pass unsanitized SQL). */
export function searchPattern(normalized: string | null): string | null {
  return normalized ? `%${escapeIlikeLiteral(normalized)}%` : null;
}

export function parsePageSize(raw: string | number | null | undefined): PageSize {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (PAGE_SIZE_OPTIONS.includes(n as PageSize)) return n as PageSize;
  return DEFAULT_PAGE_SIZE;
}

export function parsePage(raw: string | number | null | undefined): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(Math.floor(raw), Number.MAX_SAFE_INTEGER);
  }
  const text = String(raw ?? "1").trim();
  if (!/^\d+$/.test(text)) return 1;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

export function clampPage(page: number, totalPages: number): number {
  if (totalPages < 1) return 1;
  return Math.min(Math.max(1, page), totalPages);
}

export function offsetForPage(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

export function totalPages(total: number, pageSize: number): number {
  if (total <= 0) return 0;
  return Math.ceil(total / pageSize);
}

export type PaginationMeta = {
  page: number;
  pageSize: PageSize;
  total: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

export function buildPaginationMeta(
  total: number,
  page: number,
  pageSize: PageSize,
): PaginationMeta {
  const pages = totalPages(total, pageSize);
  const safePage = clampPage(page, pages || 1);
  const rangeStart = total === 0 ? 0 : offsetForPage(safePage, pageSize) + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(offsetForPage(safePage, pageSize) + pageSize, total);
  return {
    page: safePage,
    pageSize,
    total,
    totalPages: pages,
    rangeStart,
    rangeEnd,
    hasPrevious: safePage > 1,
    hasNext: pages > 0 && safePage < pages,
  };
}

export function parseToApplySort(raw: string | null | undefined): ToApplySort {
  if (raw && (TO_APPLY_SORT_OPTIONS as readonly string[]).includes(raw)) {
    return raw as ToApplySort;
  }
  return "match";
}

export function parseAppliedSort(raw: string | null | undefined): AppliedSort {
  if (raw && (APPLIED_SORT_OPTIONS as readonly string[]).includes(raw)) {
    return raw as AppliedSort;
  }
  return "applied";
}

export function parseRemoteFilter(raw: string | null | undefined): RemoteFilter {
  if (raw === "all") return "all";
  return "remote_us";
}

export type ToApplyListFilters = {
  q?: string | null;
  sort?: ToApplySort | string | null;
  remote?: string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
};

export type AppliedListFilters = {
  q?: string | null;
  sort?: AppliedSort | string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
};

export function buildDashboardQueryString(
  base: Record<string, string | number | undefined | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value == null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
