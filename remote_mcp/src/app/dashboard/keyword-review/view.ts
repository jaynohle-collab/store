export const BUCKET_LABELS = {
  stronger: "Stronger keyword matches",
  broader: "Broader keyword matches",
  needs_checking: "Needs checking",
  filtered: "Filtered jobs (audit)",
} as const;
export type ReviewBucket = keyof typeof BUCKET_LABELS;
export const PAGE_SIZE = 50;
export type ReviewFilters = { q: string; bucket?: ReviewBucket; newOnly: boolean; offset: number; from?: string; to?: string };

export function parseReviewFilters(sp: Record<string, string | string[] | undefined>): ReviewFilters {
  const rawOffset = typeof sp.offset === "string" ? sp.offset : "0";
  const offset = /^\d+$/.test(rawOffset) ? Number(rawOffset) : 0;
  const dates: { from?: string; to?: string } = {};
  for (const key of ["from", "to"] as const) {
    const value = sp[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Invalid collection date");
    dates[key] = value;
  }
  if (dates.from && dates.to && dates.from > dates.to) throw new Error("Date range is reversed");
  return {
    ...dates,
    q: typeof sp.q === "string" ? sp.q.trim().slice(0, 200) : "",
    bucket: typeof sp.bucket === "string" && Object.hasOwn(BUCKET_LABELS, sp.bucket)
      ? sp.bucket as ReviewBucket : undefined,
    newOnly: sp.new === "1",
    offset: Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000 ? offset : 0,
  };
}

export function reviewPageHref(filters: ReviewFilters, offset: number): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.newOnly) params.set("new", "1");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("offset", String(offset));
  return `/dashboard/keyword-review?${params}`;
}

/** Only public-looking HTTP(S) destinations; never fetch or rewrite supplied links.
 * This is a navigation guard, not an authenticity or DNS/redirect verification. */
export function safeListingHref(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Reject all IP literals, single-label hosts, and common private/local suffixes.
    if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
    if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) return null;
    if (host === "home.arpa" || host.endsWith(".home.arpa")) return null;
    return value;
  } catch { return null; }
}

export function reviewDate(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) return "Unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Unknown";
}

/** Human-readable display only; keep underlying policy reason tokens unchanged. */
export function humanizeReviewReason(value: string): string {
  const label = value.replace(/[_-]+/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Unspecified reason";
}

export function reviewDateBounds(filters: ReviewFilters) {
  return {
    ...(filters.from ? { freshSince: filters.from + "T00:00:00.000Z" } : {}),
    ...(filters.to ? { freshBefore: new Date(Date.parse(filters.to + "T00:00:00.000Z") + 86400000).toISOString() } : {}),
  };
}
export function reviewQuery(filters: ReviewFilters) {
  const { from, to, ...rest } = filters;
  return { ...rest, ...reviewDateBounds({ ...rest, from, to }) };
}
