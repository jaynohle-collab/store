/**
 * Server-side To Apply listing: search, sort, remote filter, GPT join, pagination.
 */

import { CLOSED_POSTING_STATUSES } from "../dashboard/constants";
import {
  buildPaginationMeta,
  clampPage,
  normalizeDashboardSearch,
  offsetForPage,
  parsePage,
  parsePageSize,
  parseRemoteFilter,
  parseToApplySort,
  searchPattern,
  totalPages,
  type ToApplyListFilters,
  type ToApplySort,
} from "../dashboard/query_params";
import {
  REMOTE_SQL_PATTERNS,
  V2_EXCLUDED_REMOTE_SCOPES,
} from "../dashboard/remote_eligibility_spec";
import {
  getActiveProfileVersion,
  getActiveScoringVersion,
  getPreferredGptEvaluationVersion,
} from "../dashboard/time";
import { getSql } from "./client";

const APPLIED_LATER = [
  "applied",
  "recruiter_screen",
  "technical_screen",
  "interview",
  "onsite",
  "offer",
  "rejected",
  "withdrawn",
  "closed",
];

const V2_EXCLUDED = V2_EXCLUDED_REMOTE_SCOPES as unknown as string[];
const P = REMOTE_SQL_PATTERNS;

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

export type ToApplyListResult = {
  jobs: Record<string, unknown>[];
  pagination: ReturnType<typeof buildPaginationMeta>;
};

export type { ToApplyListFilters };

/** Fixed sort keys only — validated before SQL interpolation in CASE expressions. */
export async function listToApplyJobs(
  filters: ToApplyListFilters = {},
): Promise<ToApplyListResult> {
  const sort: ToApplySort = parseToApplySort(
    typeof filters.sort === "string" ? filters.sort : undefined,
  );
  const pageSize = parsePageSize(filters.pageSize);
  const requestedPage = parsePage(filters.page);
  const q = searchPattern(normalizeDashboardSearch(filters.q));
  const remoteUsOnly = parseRemoteFilter(filters.remote) === "remote_us";
  const preferredGptVersion = getPreferredGptEvaluationVersion();
  const scoringVersion = getActiveScoringVersion();
  const profileVersion = getActiveProfileVersion();
  const closed = CLOSED_POSTING_STATUSES as unknown as string[];

  const sql = getSql();

  const countRows = await sql`
    WITH latest_eval AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS evaluation_id, match_score, recommendation,
        reason AS evaluation_reason, scoring_version, profile_version,
        evaluated_at, metadata
      FROM job_evaluations
      WHERE scoring_version = ${scoringVersion}
        AND profile_version = ${profileVersion}
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    ),
    posting_app AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS application_id, status AS application_status,
        applied_at, application_url
      FROM applications
      ORDER BY posting_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    ),
    prior_app AS (
      SELECT DISTINCT ON (canonical_job_id)
        canonical_job_id, id AS prior_application_id, status AS prior_application_status,
        applied_at AS prior_applied_at, posting_id AS prior_posting_id
      FROM applications
      WHERE status = ANY(${APPLIED_LATER})
      ORDER BY canonical_job_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    ),
    latest_gpt AS (
      SELECT DISTINCT ON (d.normalized_url)
        d.normalized_url,
        d.id AS gpt_evaluation_id,
        d.gpt_relevance_score,
        d.evaluation_version AS gpt_evaluation_version,
        d.remote_scope,
        d.created_at AS gpt_created_at
      FROM discovery_gpt_evaluations d
      WHERE d.normalized_url IS NOT NULL AND btrim(d.normalized_url) <> ''
      ORDER BY d.normalized_url,
        CASE
          WHEN ${preferredGptVersion}::text IS NOT NULL
            AND d.evaluation_version = ${preferredGptVersion} THEN 0
          ELSE 1
        END,
        d.created_at DESC,
        d.id DESC
    )
    SELECT COUNT(*)::int AS total
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    LEFT JOIN latest_eval le ON le.posting_id = p.id
    LEFT JOIN posting_app pa ON pa.posting_id = p.id
    LEFT JOIN prior_app prior ON prior.canonical_job_id = p.canonical_job_id
    LEFT JOIN latest_gpt lg ON lg.normalized_url = p.normalized_url
    WHERE
      NOT (LOWER(COALESCE(p.posting_status, 'active')) = ANY(${closed}))
      AND le.recommendation IN ('save', 'save_repost')
      AND (pa.application_id IS NULL OR pa.application_status = 'planned')
      AND (${q}::text IS NULL OR (
        c.company ILIKE ${q} ESCAPE '\\'
        OR c.title ILIKE ${q} ESCAPE '\\'
        OR COALESCE(p.location, '') ILIKE ${q} ESCAPE '\\'
        OR COALESCE(c.location, '') ILIKE ${q} ESCAPE '\\'
        OR COALESCE(p.source, '') ILIKE ${q} ESCAPE '\\'
        OR le.metadata::text ILIKE ${q} ESCAPE '\\'
      ))
      AND (
        ${remoteUsOnly}::boolean IS NOT TRUE
        OR (
          lg.remote_scope = 'US_NATIONWIDE'
          OR (
            (lg.gpt_evaluation_id IS NULL OR lg.remote_scope IS NULL)
            AND COALESCE(p.remote_status, '') ~* ${P.remoteStatusRemoteLike}
            AND COALESCE(p.remote_status, '') !~* ${P.remoteStatusExclude}
            AND COALESCE(p.location, c.location, '') !~* ${P.locationExcludeHybridNonUs}
            AND COALESCE(p.location, c.location, '') !~* ${P.locationExcludeRestricted}
            AND COALESCE(p.location, c.location, '') !~* ${P.usStateAbbrev}
            AND COALESCE(p.location, c.location, '') !~* ${P.usStateNames}
            AND (
              COALESCE(p.location, c.location, '') ~* ${P.usNationwide}
              OR (
                COALESCE(p.location, c.location, '') ~* ${P.locationRemoteLike}
                AND COALESCE(p.location, c.location, '') ~* ${P.locationUsCountry}
              )
            )
          )
        )
      )
      AND (lg.remote_scope IS NULL OR lg.remote_scope <> ALL(${V2_EXCLUDED}))
  `;

  const total = Number((countRows[0] as { total?: number })?.total ?? 0);
  const pages = totalPages(total, pageSize);
  const page = clampPage(requestedPage, pages || 1);
  const offset = offsetForPage(page, pageSize);
  const fetchLimit = pageSize + 1;

  const rows = await sql`
    WITH latest_eval AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS evaluation_id, match_score, recommendation,
        reason AS evaluation_reason, scoring_version, profile_version,
        evaluated_at, metadata
      FROM job_evaluations
      WHERE scoring_version = ${scoringVersion}
        AND profile_version = ${profileVersion}
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    ),
    posting_app AS (
      SELECT DISTINCT ON (posting_id)
        posting_id, id AS application_id, status AS application_status,
        applied_at, application_url
      FROM applications
      ORDER BY posting_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    ),
    prior_app AS (
      SELECT DISTINCT ON (canonical_job_id)
        canonical_job_id, id AS prior_application_id, status AS prior_application_status,
        applied_at AS prior_applied_at, posting_id AS prior_posting_id
      FROM applications
      WHERE status = ANY(${APPLIED_LATER})
      ORDER BY canonical_job_id, COALESCE(applied_at, created_at) DESC, created_at DESC
    ),
    latest_gpt AS (
      SELECT DISTINCT ON (d.normalized_url)
        d.normalized_url,
        d.id AS gpt_evaluation_id,
        d.gpt_relevance_score,
        d.evaluation_version AS gpt_evaluation_version,
        d.remote_scope,
        d.created_at AS gpt_created_at
      FROM discovery_gpt_evaluations d
      WHERE d.normalized_url IS NOT NULL AND btrim(d.normalized_url) <> ''
      ORDER BY d.normalized_url,
        CASE
          WHEN ${preferredGptVersion}::text IS NOT NULL
            AND d.evaluation_version = ${preferredGptVersion} THEN 0
          ELSE 1
        END,
        d.created_at DESC,
        d.id DESC
    )
    SELECT
      p.id AS posting_id, p.canonical_job_id, p.source, p.external_job_id, p.url,
      p.normalized_url, p.location AS posting_location, p.remote_status, p.salary,
      p.posted_date, p.first_seen_at, p.last_seen_at, p.posting_status, p.is_repost,
      p.supersedes_posting_id, c.company, c.company_key, c.title, c.normalized_title,
      c.location AS canonical_location, c.role_family,
      le.evaluation_id, le.match_score, le.recommendation, le.evaluation_reason,
      le.scoring_version, le.profile_version, le.evaluated_at,
      lg.gpt_evaluation_id, lg.gpt_relevance_score, lg.gpt_evaluation_version, lg.remote_scope,
      lg.gpt_created_at,
      pa.application_id, pa.application_status, pa.applied_at, pa.application_url,
      CASE
        WHEN p.is_repost AND prior.prior_application_id IS NOT NULL
          AND (pa.application_id IS NULL OR prior.prior_posting_id <> p.id)
        THEN TRUE ELSE FALSE
      END AS previously_applied,
      prior.prior_application_id, prior.prior_application_status,
      prior.prior_applied_at, prior.prior_posting_id
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    LEFT JOIN latest_eval le ON le.posting_id = p.id
    LEFT JOIN posting_app pa ON pa.posting_id = p.id
    LEFT JOIN prior_app prior ON prior.canonical_job_id = p.canonical_job_id
    LEFT JOIN latest_gpt lg ON lg.normalized_url = p.normalized_url
    WHERE
      NOT (LOWER(COALESCE(p.posting_status, 'active')) = ANY(${closed}))
      AND le.recommendation IN ('save', 'save_repost')
      AND (pa.application_id IS NULL OR pa.application_status = 'planned')
      AND (${q}::text IS NULL OR (
        c.company ILIKE ${q} ESCAPE '\\'
        OR c.title ILIKE ${q} ESCAPE '\\'
        OR COALESCE(p.location, '') ILIKE ${q} ESCAPE '\\'
        OR COALESCE(p.location, c.location, '') ILIKE ${q} ESCAPE '\\'
        OR COALESCE(p.source, '') ILIKE ${q} ESCAPE '\\'
        OR le.metadata::text ILIKE ${q} ESCAPE '\\'
      ))
      AND (
        ${remoteUsOnly}::boolean IS NOT TRUE
        OR (
          lg.remote_scope = 'US_NATIONWIDE'
          OR (
            (lg.gpt_evaluation_id IS NULL OR lg.remote_scope IS NULL)
            AND COALESCE(p.remote_status, '') ~* ${P.remoteStatusRemoteLike}
            AND COALESCE(p.remote_status, '') !~* ${P.remoteStatusExclude}
            AND COALESCE(p.location, c.location, '') !~* ${P.locationExcludeHybridNonUs}
            AND COALESCE(p.location, c.location, '') !~* ${P.locationExcludeRestricted}
            AND COALESCE(p.location, c.location, '') !~* ${P.usStateAbbrev}
            AND COALESCE(p.location, c.location, '') !~* ${P.usStateNames}
            AND (
              COALESCE(p.location, c.location, '') ~* ${P.usNationwide}
              OR (
                COALESCE(p.location, c.location, '') ~* ${P.locationRemoteLike}
                AND COALESCE(p.location, c.location, '') ~* ${P.locationUsCountry}
              )
            )
          )
        )
      )
      AND (lg.remote_scope IS NULL OR lg.remote_scope <> ALL(${V2_EXCLUDED}))
    ORDER BY
      CASE WHEN ${sort} = 'company' THEN c.company END ASC NULLS LAST,
      CASE WHEN ${sort} = 'title' THEN c.title END ASC NULLS LAST,
      CASE WHEN ${sort} = 'posted' THEN COALESCE(p.posted_date, p.first_seen_at) END DESC NULLS LAST,
      CASE WHEN ${sort} = 'first_seen' THEN p.first_seen_at END DESC NULLS LAST,
      CASE WHEN ${sort} = 'gpt' THEN lg.gpt_relevance_score END DESC NULLS LAST,
      CASE WHEN ${sort} = 'match' THEN le.match_score END DESC NULLS LAST,
      p.id ASC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;

  const mapped = rows.map((row) => mapRow(row as Record<string, unknown>));
  const jobs = mapped.slice(0, pageSize);
  return {
    jobs,
    pagination: buildPaginationMeta(total, page, pageSize),
  };
}
