/** Client-side sorting for the dashboard job table (current page). */

export type Job = Record<string, unknown>;
export type SortKey =
  | "company"
  | "title"
  | "location"
  | "rank"
  | "fit"
  | "posted"
  | "first_seen"
  | "status"
  | "source";
export type Dir = "asc" | "desc";

export const NUMERIC: SortKey[] = ["rank", "fit"];
export const DATES: SortKey[] = ["posted", "first_seen"];

function sortValue(job: Job, key: SortKey): string | number | null {
  const v = {
    company: job.company,
    title: job.title,
    location: job.posting_location || job.canonical_location,
    rank: job.match_score,
    fit: job.gpt_relevance_score,
    posted: job.posted_date,
    first_seen: job.first_seen_at,
    status: job.application_status,
    source: job.source,
  }[key];
  if (v == null || v === "") return null;
  if (NUMERIC.includes(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v).toLowerCase();
}

export function sortJobs(jobs: Job[], key: SortKey | null, dir: Dir): Job[] {
  if (!key) return jobs;
  const mult = dir === "asc" ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === vb) return 0;
    if (va == null) return 1; // empties always last
    if (vb == null) return -1;
    return (va < vb ? -1 : 1) * mult;
  });
}
