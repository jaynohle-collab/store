import { getSql } from "../db/client";
import {
  APPLIED_OR_LATER_STATUSES,
  CLOSED_POSTING_STATUSES,
  DEFAULT_HIGH_MATCH_THRESHOLD,
  INTERVIEW_STATUSES,
} from "../dashboard/constants";

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

export type DashboardSummary = {
  discovered_today: number;
  new_today: number;
  reposts_today: number;
  high_match_today: number;
  to_apply: number;
  applied: number;
  interviewing: number;
  high_match_threshold: number;
};

export type JobListFilters = {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  minMatch?: number;
  applicationStatus?: string;
  lifecycle?: "new" | "repost" | "all";
  remoteStatus?: string;
  company?: string;
  source?: string;
  toApply?: boolean;
  applied?: boolean;
  interviewing?: boolean;
  reposted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "newest" | "posted" | "match" | "company";
};

export type JobListResult = {
  jobs: Record<string, unknown>[];
  nextOffset: number | null;
  count: number;
};

function sortClause(sort: JobListFilters["sort"]): string {
  switch (sort) {
    case "posted":
      return "COALESCE(p.posted_date, p.first_seen_at) DESC NULLS LAST";
    case "match":
      return "le.match_score DESC NULLS LAST, p.first_seen_at DESC";
    case "company":
      return "c.company ASC, p.first_seen_at DESC";
    case "newest":
    default:
      return "p.first_seen_at DESC";
  }
}

/**
 * Combined posting + canonical + latest evaluation + application view.
 * Uses DISTINCT ON for latest evaluation to avoid N+1.
 */
export async function listDashboardJobs(filters: JobListFilters = {}): Promise<JobListResult> {
  const sql = getSql();
  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;
  const threshold = filters.minMatch ?? DEFAULT_HIGH_MATCH_THRESHOLD;
  const closed = CLOSED_POSTING_STATUSES as unknown as string[];
  const interview = INTERVIEW_STATUSES as unknown as string[];
  const appliedLater = APPLIED_OR_LATER_STATUSES as unknown as string[];

  const q = filters.q?.trim() ? `%${filters.q.trim()}%` : null;
  const company = filters.company?.trim() ? `%${filters.company.trim()}%` : null;
  const source = filters.source?.trim() || null;
  const remote = filters.remoteStatus?.trim() || null;
  const appStatus = filters.applicationStatus?.trim() || null;
  const dateFrom = filters.dateFrom ? new Date(filters.dateFrom) : null;
  const dateTo = filters.dateTo ? new Date(filters.dateTo) : null;

  const lifecycleRepost =
    filters.lifecycle === "repost" || filters.reposted === true
      ? true
      : filters.lifecycle === "new"
        ? false
        : null;

  const toApply = filters.toApply === true;
  const appliedOnly = filters.applied === true;
  const interviewingOnly = filters.interviewing === true;

  // Neon tagged templates don't support dynamic ORDER BY easily — use fixed sorts via branches.
  const fetchLimit = limit + 1;

  const rows = await sql`
    WITH latest_eval AS (
      SELECT DISTINCT ON (posting_id)
        posting_id,
        id AS evaluation_id,
        match_score,
        recommendation,
        reason AS evaluation_reason,
        scoring_version,
        profile_version,
        evaluated_at
      FROM job_evaluations
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    ),
    posting_app AS (
      SELECT DISTINCT ON (posting_id)
        posting_id,
        id AS application_id,
        status AS application_status,
        applied_at,
        application_url
      FROM applications
      ORDER BY posting_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    ),
    prior_app AS (
      SELECT DISTINCT ON (canonical_job_id)
        canonical_job_id,
        id AS prior_application_id,
        status AS prior_application_status,
        applied_at AS prior_applied_at,
        posting_id AS prior_posting_id
      FROM applications
      WHERE status = ANY(${appliedLater})
      ORDER BY canonical_job_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    )
    SELECT
      p.id AS posting_id,
      p.canonical_job_id,
      p.source,
      p.external_job_id,
      p.url,
      p.normalized_url,
      p.location AS posting_location,
      p.remote_status,
      p.salary,
      p.posted_date,
      p.first_seen_at,
      p.last_seen_at,
      p.posting_status,
      p.is_repost,
      p.supersedes_posting_id,
      c.company,
      c.company_key,
      c.title,
      c.normalized_title,
      c.location AS canonical_location,
      c.role_family,
      le.evaluation_id,
      le.match_score,
      le.recommendation,
      le.evaluation_reason,
      le.scoring_version,
      le.profile_version,
      le.evaluated_at,
      pa.application_id,
      pa.application_status,
      pa.applied_at,
      pa.application_url,
      CASE
        WHEN p.is_repost AND prior.prior_application_id IS NOT NULL
          AND (pa.application_id IS NULL OR prior.prior_posting_id <> p.id)
        THEN TRUE ELSE FALSE
      END AS previously_applied,
      prior.prior_application_id,
      prior.prior_application_status,
      prior.prior_applied_at,
      prior.prior_posting_id
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    LEFT JOIN latest_eval le ON le.posting_id = p.id
    LEFT JOIN posting_app pa ON pa.posting_id = p.id
    LEFT JOIN prior_app prior ON prior.canonical_job_id = p.canonical_job_id
    WHERE
      (${q}::text IS NULL OR (
        c.company ILIKE ${q}
        OR c.title ILIKE ${q}
        OR COALESCE(p.url, '') ILIKE ${q}
        OR COALESCE(p.normalized_url, '') ILIKE ${q}
        OR COALESCE(pa.application_url, '') ILIKE ${q}
        OR COALESCE(p.source, '') ILIKE ${q}
        OR COALESCE(p.external_job_id, '') ILIKE ${q}
      ))
      AND (${company}::text IS NULL OR c.company ILIKE ${company})
      AND (${source}::text IS NULL OR p.source = ${source})
      AND (${remote}::text IS NULL OR p.remote_status = ${remote})
      AND (${appStatus}::text IS NULL OR pa.application_status = ${appStatus})
      AND (${dateFrom}::timestamptz IS NULL OR p.first_seen_at >= ${dateFrom})
      AND (${dateTo}::timestamptz IS NULL OR p.first_seen_at < ${dateTo})
      AND (${lifecycleRepost}::boolean IS NULL OR p.is_repost = ${lifecycleRepost})
      AND (
        ${toApply}::boolean IS NOT TRUE
        OR (
          NOT (LOWER(COALESCE(p.posting_status, 'active')) = ANY(${closed}))
          AND le.match_score IS NOT NULL
          AND le.match_score >= ${threshold}
          AND pa.application_id IS NULL
        )
      )
      AND (
        ${appliedOnly}::boolean IS NOT TRUE
        OR pa.application_status = ANY(${appliedLater})
      )
      AND (
        ${interviewingOnly}::boolean IS NOT TRUE
        OR pa.application_status = ANY(${interview})
      )
    ORDER BY p.first_seen_at DESC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;

  // Apply requested sort in JS when not newest — keeps SQL portable with neon.
  let jobs = rows.map((row) => mapRow(row as Record<string, unknown>));
  if (filters.sort && filters.sort !== "newest") {
    jobs = [...jobs].sort((a, b) => {
      if (filters.sort === "company") {
        return String(a.company || "").localeCompare(String(b.company || ""));
      }
      if (filters.sort === "match") {
        return Number(b.match_score ?? -1) - Number(a.match_score ?? -1);
      }
      if (filters.sort === "posted") {
        return String(b.posted_date || b.first_seen_at || "").localeCompare(
          String(a.posted_date || a.first_seen_at || ""),
        );
      }
      return 0;
    });
  }

  void sortClause; // documented intent for future SQL sort variants
  const hasMore = jobs.length > limit;
  const page = jobs.slice(0, limit);
  return {
    jobs: page,
    count: page.length,
    nextOffset: hasMore ? offset + page.length : null,
  };
}

export async function getDashboardJob(postingId: string): Promise<Record<string, unknown> | null> {
  const page = await listDashboardJobs({ q: undefined, limit: 1, offset: 0 });
  // Direct lookup
  const sql = getSql();
  const closed = CLOSED_POSTING_STATUSES as unknown as string[];
  const appliedLater = APPLIED_OR_LATER_STATUSES as unknown as string[];
  void closed;

  const rows = await sql`
    WITH latest_eval AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS evaluation_id, match_score, recommendation,
        reason AS evaluation_reason, scoring_version, profile_version, evaluated_at
      FROM job_evaluations
      WHERE posting_id = ${postingId}::uuid
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    ),
    posting_app AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS application_id, status AS application_status,
        applied_at, application_url, resume_version, notes
      FROM applications
      WHERE posting_id = ${postingId}::uuid
      ORDER BY posting_id, COALESCE(applied_at, created_at) DESC
    ),
    prior_app AS (
      SELECT DISTINCT ON (a.canonical_job_id)
        a.canonical_job_id,
        a.id AS prior_application_id,
        a.status AS prior_application_status,
        a.applied_at AS prior_applied_at,
        a.posting_id AS prior_posting_id
      FROM applications a
      JOIN job_postings p ON p.canonical_job_id = a.canonical_job_id
      WHERE p.id = ${postingId}::uuid
        AND a.status = ANY(${appliedLater})
        AND a.posting_id <> ${postingId}::uuid
      ORDER BY a.canonical_job_id, COALESCE(a.applied_at, a.created_at) DESC
    )
    SELECT
      p.*,
      c.company, c.company_key, c.title, c.normalized_title,
      c.location AS canonical_location, c.role_family,
      le.*,
      pa.application_id, pa.application_status, pa.applied_at,
      pa.application_url, pa.resume_version, pa.notes,
      prior.prior_application_id, prior.prior_application_status,
      prior.prior_applied_at, prior.prior_posting_id,
      (prior.prior_application_id IS NOT NULL) AS previously_applied
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    LEFT JOIN latest_eval le ON le.posting_id = p.id
    LEFT JOIN posting_app pa ON pa.posting_id = p.id
    LEFT JOIN prior_app prior ON prior.canonical_job_id = p.canonical_job_id
    WHERE p.id = ${postingId}::uuid
    LIMIT 1
  `;
  void page;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function getDashboardSummary(
  highMatchThreshold = DEFAULT_HIGH_MATCH_THRESHOLD,
): Promise<DashboardSummary> {
  const sql = getSql();
  const closed = CLOSED_POSTING_STATUSES as unknown as string[];
  const interview = INTERVIEW_STATUSES as unknown as string[];
  const appliedLater = APPLIED_OR_LATER_STATUSES as unknown as string[];

  const rows = await sql`
    WITH latest_eval AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, match_score
      FROM job_evaluations
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    ),
    posting_app AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, status
      FROM applications
      ORDER BY posting_id, COALESCE(applied_at, created_at) DESC
    ),
    today_postings AS (
      SELECT p.*, le.match_score, pa.status AS application_status
      FROM job_postings p
      LEFT JOIN latest_eval le ON le.posting_id = p.id
      LEFT JOIN posting_app pa ON pa.posting_id = p.id
      WHERE p.first_seen_at >= date_trunc('day', NOW())
        AND p.first_seen_at < date_trunc('day', NOW()) + interval '1 day'
    )
    SELECT
      (SELECT COUNT(*)::int FROM today_postings) AS discovered_today,
      (SELECT COUNT(*)::int FROM today_postings WHERE is_repost = FALSE) AS new_today,
      (SELECT COUNT(*)::int FROM today_postings WHERE is_repost = TRUE) AS reposts_today,
      (SELECT COUNT(*)::int FROM today_postings
        WHERE match_score IS NOT NULL AND match_score >= ${highMatchThreshold}) AS high_match_today,
      (SELECT COUNT(*)::int FROM job_postings p
        LEFT JOIN latest_eval le ON le.posting_id = p.id
        LEFT JOIN posting_app pa ON pa.posting_id = p.id
        WHERE NOT (LOWER(COALESCE(p.posting_status, 'active')) = ANY(${closed}))
          AND le.match_score IS NOT NULL
          AND le.match_score >= ${highMatchThreshold}
          AND pa.posting_id IS NULL
      ) AS to_apply,
      (SELECT COUNT(*)::int FROM applications
        WHERE status = ANY(${appliedLater})) AS applied,
      (SELECT COUNT(*)::int FROM applications
        WHERE status = ANY(${interview})) AS interviewing
  `;

  const row = rows[0] as Record<string, unknown>;
  return {
    discovered_today: Number(row.discovered_today ?? 0),
    new_today: Number(row.new_today ?? 0),
    reposts_today: Number(row.reposts_today ?? 0),
    high_match_today: Number(row.high_match_today ?? 0),
    to_apply: Number(row.to_apply ?? 0),
    applied: Number(row.applied ?? 0),
    interviewing: Number(row.interviewing ?? 0),
    high_match_threshold: highMatchThreshold,
  };
}

export async function listApplicationsPage(params: {
  status?: string;
  interviewing?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ applications: Record<string, unknown>[]; nextOffset: number | null }> {
  const sql = getSql();
  const limit = Math.min(params.limit ?? 50, 100);
  const offset = params.offset ?? 0;
  const interview = INTERVIEW_STATUSES as unknown as string[];
  const q = params.q?.trim() ? `%${params.q.trim()}%` : null;
  const status = params.status?.trim() || null;
  const interviewing = params.interviewing === true;

  const rows = await sql`
    SELECT
      a.*,
      c.company,
      c.title,
      p.url AS posting_url,
      p.is_repost,
      p.source
    FROM applications a
    JOIN canonical_jobs c ON c.id = a.canonical_job_id
    JOIN job_postings p ON p.id = a.posting_id
    WHERE
      (${status}::text IS NULL OR a.status = ${status})
      AND (${interviewing}::boolean IS NOT TRUE OR a.status = ANY(${interview}))
      AND (${q}::text IS NULL OR (
        c.company ILIKE ${q}
        OR c.title ILIKE ${q}
        OR COALESCE(a.application_url, '') ILIKE ${q}
        OR COALESCE(p.url, '') ILIKE ${q}
      ))
    ORDER BY COALESCE(a.applied_at, a.created_at) DESC
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `;
  const mapped = rows.map((row) => mapRow(row as Record<string, unknown>));
  const hasMore = mapped.length > limit;
  const applications = mapped.slice(0, limit);
  return { applications, nextOffset: hasMore ? offset + applications.length : null };
}

export async function getApplicationDetail(
  applicationId: string,
): Promise<{ application: Record<string, unknown>; events: Record<string, unknown>[] } | null> {
  const sql = getSql();
  const apps = await sql`
    SELECT
      a.*,
      c.company,
      c.title,
      p.url AS posting_url,
      p.is_repost,
      p.source,
      p.external_job_id
    FROM applications a
    JOIN canonical_jobs c ON c.id = a.canonical_job_id
    JOIN job_postings p ON p.id = a.posting_id
    WHERE a.id = ${applicationId}::uuid
    LIMIT 1
  `;
  if (!apps.length) return null;
  const events = await sql`
    SELECT * FROM application_events
    WHERE application_id = ${applicationId}::uuid
    ORDER BY event_at ASC, created_at ASC
  `;
  return {
    application: mapRow(apps[0] as Record<string, unknown>),
    events: events.map((row) => mapRow(row as Record<string, unknown>)),
  };
}

export async function markApplied(input: {
  postingId: string;
  applicationUrl?: string;
  resumeVersion?: string;
  notes?: string;
  appliedAt?: string;
}): Promise<{ application: Record<string, unknown>; event: Record<string, unknown> }> {
  const sql = getSql();
  const postings = await sql`
    SELECT id, canonical_job_id, url FROM job_postings
    WHERE id = ${input.postingId}::uuid
    LIMIT 1
  `;
  if (!postings.length) {
    throw new Error(`posting_id ${input.postingId} not found`);
  }
  const posting = postings[0] as { id: string; canonical_job_id: string; url: string | null };
  const appliedAt = input.appliedAt ? new Date(input.appliedAt) : new Date();
  const appRows = await sql`
    INSERT INTO applications (
      canonical_job_id, posting_id, applied_at, status,
      application_url, resume_version, notes
    ) VALUES (
      ${posting.canonical_job_id}::uuid,
      ${posting.id}::uuid,
      ${appliedAt},
      'applied',
      ${input.applicationUrl ?? posting.url},
      ${input.resumeVersion ?? null},
      ${input.notes ?? null}
    )
    RETURNING *
  `;
  const application = mapRow(appRows[0] as Record<string, unknown>);
  const eventRows = await sql`
    INSERT INTO application_events (
      application_id, event_type, event_at, notes, metadata
    ) VALUES (
      ${application.id}::uuid,
      'applied',
      ${appliedAt},
      ${input.notes ?? null},
      '{}'::jsonb
    )
    RETURNING *
  `;
  return {
    application,
    event: mapRow(eventRows[0] as Record<string, unknown>),
  };
}

export async function updateApplicationWithEvent(input: {
  applicationId: string;
  status: string;
  notes?: string;
}): Promise<{ application: Record<string, unknown>; event: Record<string, unknown> }> {
  const sql = getSql();
  const rows = await sql`
    UPDATE applications
    SET status = ${input.status},
        notes = COALESCE(${input.notes ?? null}, notes),
        updated_at = NOW()
    WHERE id = ${input.applicationId}::uuid
    RETURNING *
  `;
  if (!rows.length) {
    throw new Error(`application ${input.applicationId} not found`);
  }
  const application = mapRow(rows[0] as Record<string, unknown>);
  const eventRows = await sql`
    INSERT INTO application_events (
      application_id, event_type, event_at, notes, metadata
    ) VALUES (
      ${input.applicationId}::uuid,
      ${input.status},
      NOW(),
      ${input.notes ?? null},
      '{}'::jsonb
    )
    RETURNING *
  `;
  return {
    application,
    event: mapRow(eventRows[0] as Record<string, unknown>),
  };
}

export async function ignorePosting(postingId: string): Promise<Record<string, unknown> | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE job_postings
    SET posting_status = 'ignored', updated_at = NOW()
    WHERE id = ${postingId}::uuid
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function listDiscoveryRunsPage(limit = 30, offset = 0) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_runs
    ORDER BY started_at DESC
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `;
  const mapped = rows.map((row) => mapRow(row as Record<string, unknown>));
  const hasMore = mapped.length > limit;
  const runs = mapped.slice(0, limit);
  return { discovery_runs: runs, nextOffset: hasMore ? offset + runs.length : null };
}
