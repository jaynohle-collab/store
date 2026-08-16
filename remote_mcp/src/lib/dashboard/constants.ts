/** Dashboard thresholds and status sets — not scoring logic. */

export const DEFAULT_HIGH_MATCH_THRESHOLD = Number(
  process.env.DASHBOARD_HIGH_MATCH_THRESHOLD ?? "70",
);

export const CLOSED_POSTING_STATUSES = [
  "closed",
  "expired",
  "removed",
  "inactive",
  "ignored",
  "filled",
] as const;

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
