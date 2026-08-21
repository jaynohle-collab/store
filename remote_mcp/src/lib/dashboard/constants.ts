/** Dashboard thresholds and status sets — not scoring logic. */

export const DEFAULT_HIGH_MATCH_THRESHOLD = Number(
  process.env.DASHBOARD_HIGH_MATCH_THRESHOLD ?? "70",
);

/** Recommendations that qualify a posting for the To Apply queue. */
export const TO_APPLY_RECOMMENDATIONS = ["save", "save_repost"] as const;

export const CLOSED_POSTING_STATUSES = [
  "closed",
  "expired",
  "removed",
  "inactive",
  "ignored",
  "filled",
] as const;

export type ToApplyCandidate = {
  posting_status?: string | null;
  recommendation?: string | null;
  application_id?: string | null;
  match_score?: number | null;
};

/** Pure To Apply eligibility — mirrors dashboard SQL (no score threshold). */
export function isToApplyEligible(job: ToApplyCandidate): boolean {
  const status = String(job.posting_status ?? "active").toLowerCase();
  if ((CLOSED_POSTING_STATUSES as readonly string[]).includes(status)) {
    return false;
  }
  if (job.application_id != null && String(job.application_id) !== "") {
    return false;
  }
  const recommendation = String(job.recommendation ?? "");
  return (TO_APPLY_RECOMMENDATIONS as readonly string[]).includes(recommendation);
}

/** High Match indicator / count helper — uses DASHBOARD_HIGH_MATCH_THRESHOLD. */
export function isHighMatch(
  matchScore: number | null | undefined,
  threshold: number = DEFAULT_HIGH_MATCH_THRESHOLD,
): boolean {
  return (
    matchScore != null &&
    Number.isFinite(Number(matchScore)) &&
    Number(matchScore) >= threshold
  );
}

/** Filter To Apply candidates and sort by match score descending. */
export function selectToApplyJobs<T extends ToApplyCandidate>(jobs: T[]): T[] {
  return jobs
    .filter(isToApplyEligible)
    .sort((a, b) => {
      const am = a.match_score;
      const bm = b.match_score;
      if (am == null && bm == null) return 0;
      if (am == null) return 1;
      if (bm == null) return -1;
      return Number(bm) - Number(am);
    });
}

export const INTERVIEW_STATUSES = [
  "recruiter_screen",
  "technical_screen",
  "interview",
  "onsite",
] as const;

export const APPLIED_OR_LATER_STATUSES = [
  "applied",
  "recruiter_screen",
  "technical_screen",
  "interview",
  "onsite",
  "offer",
  "rejected",
  "withdrawn",
  "closed",
] as const;

export const APPLICATION_STATUS_TRANSITIONS = [
  "planned",
  "applied",
  "recruiter_screen",
  "technical_screen",
  "interview",
  "onsite",
  "offer",
  "rejected",
  "withdrawn",
  "closed",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUS_TRANSITIONS)[number];
