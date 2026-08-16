/**
 * Dashboard job sort comparators mirroring PostgreSQL ORDER BY branches
 * (used by tests to prove global sort-before-pagination semantics).
 */

export type DashboardSort = "newest" | "posted" | "match" | "company";

export type SortableJob = {
  id: string;
  first_seen_at: string;
  posted_date?: string | null;
  company?: string | null;
  match_score?: number | null;
};

function ts(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

function cmpIdDesc(a: SortableJob, b: SortableJob): number {
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Same ordering as listDashboardJobs SQL branches (before LIMIT/OFFSET). */
export function compareDashboardJobs(
  a: SortableJob,
  b: SortableJob,
  sort: DashboardSort,
): number {
  if (sort === "match") {
    const am = a.match_score;
    const bm = b.match_score;
    if (am == null && bm == null) {
      /* fall through */
    } else if (am == null) return 1;
    else if (bm == null) return -1;
    else if (am !== bm) return bm - am;
    const seen = ts(b.first_seen_at) - ts(a.first_seen_at);
    if (seen !== 0) return seen;
    return cmpIdDesc(a, b);
  }
  if (sort === "posted") {
    const ap = ts(a.posted_date ?? a.first_seen_at);
    const bp = ts(b.posted_date ?? b.first_seen_at);
    if (ap !== bp) return bp - ap;
    return cmpIdDesc(a, b);
  }
  if (sort === "company") {
    const ac = (a.company ?? "").toLowerCase();
    const bc = (b.company ?? "").toLowerCase();
    if (ac !== bc) return ac < bc ? -1 : 1;
    const seen = ts(b.first_seen_at) - ts(a.first_seen_at);
    if (seen !== 0) return seen;
    return cmpIdDesc(a, b);
  }
  // newest
  const seen = ts(b.first_seen_at) - ts(a.first_seen_at);
  if (seen !== 0) return seen;
  return cmpIdDesc(a, b);
}

export function paginateSortedJobs<T extends SortableJob>(
  jobs: T[],
  sort: DashboardSort,
  limit: number,
  offset: number,
): T[] {
  const sorted = [...jobs].sort((a, b) => compareDashboardJobs(a, b, sort));
  return sorted.slice(offset, offset + limit);
}

/** Fixed SQL ORDER BY fragments — never interpolate user input into these. */
export const DASHBOARD_JOB_ORDER_BY_SQL: Record<DashboardSort, string> = {
  newest: "ORDER BY p.first_seen_at DESC, p.id DESC",
  posted: "ORDER BY COALESCE(p.posted_date, p.first_seen_at) DESC NULLS LAST, p.id DESC",
  match: "ORDER BY le.match_score DESC NULLS LAST, p.first_seen_at DESC, p.id DESC",
  company: "ORDER BY c.company ASC, p.first_seen_at DESC, p.id DESC",
};
