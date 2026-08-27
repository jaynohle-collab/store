/**
 * Discovery company registry + adaptive claim leases (Milestone 5).
 * MCP owns persistence; Python owns ATS crawl + LLM evaluation.
 */

import { z } from "zod";

import { getSql, getTransactionalSql } from "./client";
import {
  computeNextEligibleAt,
  type ErrorCategory,
  type ScanPriority,
} from "../discovery/company_schedule";
import {
  DEFAULT_STORAGE_SOFT_LIMIT_BYTES,
  isApproachingStorageLimit,
  previewDescriptionRetentionSchema,
  summarizeRetentionPreview,
  type PreviewDescriptionRetentionInput,
} from "../discovery/storage_retention";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

const ATS_PROVIDERS = [
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "company_careers",
  "workable",
  "smartrecruiters",
  "teamtailor",
  "recruitee",
  "bamboohr",
  "jobvite",
  "icims",
  "personio",
  "rippling",
  "comeet",
  "pinpoint",
  "other",
] as const;

const SCAN_PRIORITIES = ["manual", "hot", "high", "normal", "inactive"] as const;

export const upsertDiscoveryCompanySchema = z
  .object({
    company_key: z.string().min(1).max(128),
    company_name: z.string().min(1).max(512),
    careers_url: z.string().max(2048).optional().nullable(),
    ats_provider: z.enum(ATS_PROVIDERS),
    ats_org_id: z.string().max(256).optional().nullable(),
    enabled: z.boolean().optional().default(true),
    scan_priority: z.enum(SCAN_PRIORITIES).optional().default("normal"),
    force_scan_now: z.boolean().optional().default(false),
  })
  .strict();

export const claimDueDiscoveryCompaniesSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(10),
    lease_minutes: z.number().int().min(5).max(180).default(30),
    worker_identity: z.string().min(1).max(128).default("automatic-discovery"),
    recover_stale: z.boolean().optional().default(true),
  })
  .strict();

export const completeDiscoveryCompanyRunSchema = z
  .object({
    run_id: z.string().uuid(),
    metrics: z.record(z.string(), z.unknown()).optional().default({}),
    success: z.boolean().default(true),
  })
  .strict();

export const failDiscoveryCompanyRunSchema = z
  .object({
    run_id: z.string().uuid(),
    error_category: z
      .enum([
        "rate_limit",
        "timeout",
        "not_found",
        "server_error",
        "network",
        "validation",
        "llm_quota",
        "ssrf_blocked",
        "unknown",
      ])
      .default("unknown"),
    error_summary: z.string().max(1000),
    metrics: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export const startAutomaticDiscoveryRunSchema = z
  .object({
    worker_identity: z.string().min(1).max(128).default("automatic-discovery"),
    llm_provider: z.string().max(64).optional().nullable(),
  })
  .strict();

export const finishAutomaticDiscoveryRunSchema = z
  .object({
    run_id: z.string().uuid(),
    status: z.enum(["completed", "failed", "partial"]),
    metrics: z.record(z.string(), z.unknown()).optional().default({}),
    error_summary: z.string().max(2000).optional().nullable(),
    llm_provider: z.string().max(64).optional().nullable(),
  })
  .strict();

function sanitizeErrorSummary(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "[REDACTED]")
    .slice(0, 1000);
}

export async function listDiscoveryCompanies(limit = 100, offset = 0) {
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM discovery_companies
    ORDER BY enabled DESC, next_eligible_at ASC, company_key ASC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
    OFFSET ${Math.max(offset, 0)}
  `;
  return (rows as Record<string, unknown>[]).map((row) => mapRow(row));
}

export async function upsertDiscoveryCompany(
  raw: z.infer<typeof upsertDiscoveryCompanySchema>,
) {
  const input = upsertDiscoveryCompanySchema.parse(raw);
  const sql = getSql();
  const nextEligible = input.force_scan_now
    ? new Date()
    : computeNextEligibleAt({
        priority: input.scan_priority as ScanPriority,
        success: true,
      });

  const rows = await sql`
    INSERT INTO discovery_companies (
      company_key, company_name, careers_url, ats_provider, ats_org_id,
      enabled, scan_priority, next_eligible_at, updated_at
    ) VALUES (
      ${input.company_key.trim().toLowerCase()},
      ${input.company_name.trim()},
      ${input.careers_url ?? null},
      ${input.ats_provider},
      ${input.ats_org_id?.trim() || null},
      ${input.enabled ?? true},
      ${input.scan_priority ?? "normal"},
      ${nextEligible},
      NOW()
    )
    ON CONFLICT (company_key) DO UPDATE SET
      company_name = EXCLUDED.company_name,
      careers_url = EXCLUDED.careers_url,
      ats_provider = EXCLUDED.ats_provider,
      ats_org_id = EXCLUDED.ats_org_id,
      enabled = EXCLUDED.enabled,
      scan_priority = EXCLUDED.scan_priority,
      next_eligible_at = CASE
        WHEN ${input.force_scan_now} THEN NOW()
        ELSE discovery_companies.next_eligible_at
      END,
      updated_at = NOW()
    RETURNING *
  `;
  return mapRow((rows as Record<string, unknown>[])[0]);
}

export async function recoverStaleDiscoveryCompanyLeases(limit = 50): Promise<number> {
  const sql = getTransactionalSql();
  const capped = Math.min(Math.max(limit, 1), 50);
  // Expire one stale lease per statement using a CTE; loop for bound recovery.
  let recovered = 0;
  for (let i = 0; i < capped; i += 1) {
    const results = await sql.transaction([
      sql`
        WITH stale AS (
          SELECT c.id AS company_id, c.active_run_id, c.scan_priority, c.consecutive_failures
          FROM discovery_companies c
          JOIN discovery_company_runs r ON r.id = c.active_run_id
          WHERE c.active_run_id IS NOT NULL
            AND r.status = 'claimed'
            AND r.lease_expires_at <= NOW()
          ORDER BY r.lease_expires_at ASC
          FOR UPDATE OF c, r SKIP LOCKED
          LIMIT 1
        ),
        expired AS (
          UPDATE discovery_company_runs r
          SET status = 'expired',
              completed_at = NOW(),
              error_category = 'timeout',
              error_summary = 'lease_expired',
              updated_at = NOW()
          FROM stale s
          WHERE r.id = s.active_run_id AND r.status = 'claimed'
          RETURNING r.id, s.company_id, s.scan_priority, s.consecutive_failures
        ),
        updated AS (
          UPDATE discovery_companies c
          SET active_run_id = NULL,
              lease_expires_at = NULL,
              consecutive_failures = e.consecutive_failures + 1,
              last_error_category = 'timeout',
              last_error_summary = 'lease_expired',
              next_eligible_at = NOW() + make_interval(
                hours => LEAST(720, POWER(2, e.consecutive_failures)::int)
              ),
              backoff_until = NOW() + make_interval(
                hours => LEAST(720, POWER(2, e.consecutive_failures)::int)
              ),
              updated_at = NOW()
          FROM expired e
          WHERE c.id = e.company_id
          RETURNING c.id
        )
        SELECT COUNT(*)::int AS count FROM updated
      `,
    ]);
    const count = Number((results[0]?.[0] as { count?: number } | undefined)?.count || 0);
    if (count === 0) break;
    recovered += count;
  }
  return recovered;
}

async function claimOneDueCompany(
  workerIdentity: string,
  leaseMinutes: number,
): Promise<{ company: Record<string, unknown>; run: Record<string, unknown> } | null> {
  const sql = getTransactionalSql();
  const leaseMins = Math.min(Math.max(leaseMinutes, 5), 180);
  const results = await sql.transaction([
    sql`
      WITH picked AS (
        SELECT id
        FROM discovery_companies
        WHERE enabled = TRUE
          AND active_run_id IS NULL
          AND next_eligible_at <= NOW()
          AND (backoff_until IS NULL OR backoff_until <= NOW())
        ORDER BY
          CASE scan_priority
            WHEN 'manual' THEN 0
            WHEN 'hot' THEN 1
            WHEN 'high' THEN 2
            WHEN 'normal' THEN 3
            ELSE 4
          END,
          next_eligible_at ASC,
          company_key ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ),
      attempt AS (
        INSERT INTO discovery_company_runs (
          company_id, status, worker_identity, lease_expires_at
        )
        SELECT id, 'claimed', ${workerIdentity}, NOW() + make_interval(mins => ${leaseMins})
        FROM picked
        RETURNING *
      ),
      updated AS (
        UPDATE discovery_companies c
        SET active_run_id = a.id,
            lease_expires_at = a.lease_expires_at,
            last_attempted_at = NOW(),
            updated_at = NOW()
        FROM picked p
        INNER JOIN attempt a ON a.company_id = p.id
        WHERE c.id = p.id
          AND c.active_run_id IS NULL
        RETURNING c.*, a.id AS claimed_run_id
      )
      SELECT
        u.*,
        a.id AS run_id,
        a.status AS run_status,
        a.worker_identity AS run_worker_identity,
        a.started_at AS run_started_at,
        a.lease_expires_at AS run_lease_expires_at
      FROM updated u
      JOIN attempt a ON a.id = u.claimed_run_id
    `,
  ]);
  const rows = results[0] ?? [];
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  const company = mapRow({
    id: row.id,
    company_key: row.company_key,
    company_name: row.company_name,
    careers_url: row.careers_url,
    ats_provider: row.ats_provider,
    ats_org_id: row.ats_org_id,
    enabled: row.enabled,
    scan_priority: row.scan_priority,
    last_attempted_at: row.last_attempted_at,
    last_success_at: row.last_success_at,
    next_eligible_at: row.next_eligible_at,
    consecutive_failures: row.consecutive_failures,
    stats: row.stats,
  });
  const run = mapRow({
    id: row.run_id,
    company_id: row.id,
    status: row.run_status,
    worker_identity: row.run_worker_identity,
    started_at: row.run_started_at,
    lease_expires_at: row.run_lease_expires_at,
  });
  return { company, run };
}

export async function claimDueDiscoveryCompanies(
  raw: z.infer<typeof claimDueDiscoveryCompaniesSchema>,
) {
  const input = claimDueDiscoveryCompaniesSchema.parse(raw);
  if (input.recover_stale) {
    await recoverStaleDiscoveryCompanyLeases(input.limit);
  }

  const claimed: Record<string, unknown>[] = [];
  for (let i = 0; i < input.limit; i += 1) {
    const one = await claimOneDueCompany(input.worker_identity, input.lease_minutes);
    if (!one) break;
    claimed.push(one);
  }

  return {
    claimed_count: claimed.length,
    claims: claimed,
    lease_minutes: input.lease_minutes,
  };
}

export async function completeDiscoveryCompanyRun(
  raw: z.infer<typeof completeDiscoveryCompanyRunSchema>,
) {
  const input = completeDiscoveryCompanyRunSchema.parse(raw);
  const sql = getTransactionalSql();
  const metricsJson = JSON.stringify(input.metrics || {});

  const existing = await getSql()`
    SELECT r.*, c.scan_priority
    FROM discovery_company_runs r
    JOIN discovery_companies c ON c.id = r.company_id
    WHERE r.id = ${input.run_id}::uuid
  `;
  if (!(existing as unknown[]).length) {
    throw new Error(`discovery company run not found: ${input.run_id}`);
  }
  const prior = (existing as Record<string, unknown>[])[0];
  if (String(prior.status) !== "claimed") {
    return { ok: true, idempotent_replay: true, run: mapRow(prior) };
  }

  const priority = String(prior.scan_priority || "normal") as ScanPriority;
  const next = computeNextEligibleAt({ priority, success: input.success });

  const results = await sql.transaction([
    sql`
      WITH done AS (
        UPDATE discovery_company_runs
        SET status = 'completed',
            completed_at = NOW(),
            metrics = ${metricsJson}::jsonb,
            updated_at = NOW()
        WHERE id = ${input.run_id}::uuid AND status = 'claimed'
        RETURNING *
      ),
      company AS (
        UPDATE discovery_companies c
        SET active_run_id = NULL,
            lease_expires_at = NULL,
            consecutive_failures = 0,
            last_success_at = NOW(),
            last_error_category = NULL,
            last_error_summary = NULL,
            backoff_until = NULL,
            next_eligible_at = ${next},
            stats = COALESCE(stats, '{}'::jsonb) || ${metricsJson}::jsonb,
            updated_at = NOW()
        FROM done d
        WHERE c.id = d.company_id
        RETURNING c.id
      )
      SELECT d.* FROM done d
    `,
  ]);
  const rows = results[0] ?? [];
  if (!rows.length) {
    const again = await getSql()`
      SELECT * FROM discovery_company_runs WHERE id = ${input.run_id}::uuid
    `;
    return {
      ok: true,
      idempotent_replay: true,
      run: mapRow((again as Record<string, unknown>[])[0]),
    };
  }
  return {
    ok: true,
    idempotent_replay: false,
    run: mapRow(rows[0] as Record<string, unknown>),
    next_eligible_at: next.toISOString(),
  };
}

export async function failDiscoveryCompanyRun(
  raw: z.infer<typeof failDiscoveryCompanyRunSchema>,
) {
  const input = failDiscoveryCompanyRunSchema.parse(raw);
  const summary = sanitizeErrorSummary(input.error_summary);
  const sql = getTransactionalSql();
  const metricsJson = JSON.stringify(input.metrics || {});

  const existing = await getSql()`
    SELECT r.*, c.scan_priority, c.consecutive_failures
    FROM discovery_company_runs r
    JOIN discovery_companies c ON c.id = r.company_id
    WHERE r.id = ${input.run_id}::uuid
  `;
  if (!(existing as unknown[]).length) {
    throw new Error(`discovery company run not found: ${input.run_id}`);
  }
  const prior = (existing as Record<string, unknown>[])[0];
  if (String(prior.status) !== "claimed") {
    return { ok: true, idempotent_replay: true, run: mapRow(prior) };
  }

  const failures = Number(prior.consecutive_failures || 0) + 1;
  const priority = String(prior.scan_priority || "normal") as ScanPriority;
  const next = computeNextEligibleAt({
    priority,
    success: false,
    consecutiveFailures: failures,
  });

  const results = await sql.transaction([
    sql`
      WITH done AS (
        UPDATE discovery_company_runs
        SET status = 'failed',
            completed_at = NOW(),
            error_category = ${input.error_category},
            error_summary = ${summary},
            metrics = ${metricsJson}::jsonb,
            updated_at = NOW()
        WHERE id = ${input.run_id}::uuid AND status = 'claimed'
        RETURNING *
      ),
      company AS (
        UPDATE discovery_companies c
        SET active_run_id = NULL,
            lease_expires_at = NULL,
            consecutive_failures = ${failures},
            last_error_category = ${input.error_category},
            last_error_summary = ${summary},
            next_eligible_at = ${next},
            backoff_until = ${next},
            updated_at = NOW()
        FROM done d
        WHERE c.id = d.company_id
        RETURNING c.id
      )
      SELECT d.* FROM done d
    `,
  ]);
  const rows = results[0] ?? [];
  if (!rows.length) {
    const again = await getSql()`
      SELECT * FROM discovery_company_runs WHERE id = ${input.run_id}::uuid
    `;
    return {
      ok: true,
      idempotent_replay: true,
      run: mapRow((again as Record<string, unknown>[])[0]),
    };
  }
  return {
    ok: true,
    idempotent_replay: false,
    run: mapRow(rows[0] as Record<string, unknown>),
    next_eligible_at: next.toISOString(),
    consecutive_failures: failures,
  };
}

export async function startAutomaticDiscoveryRun(
  raw: z.infer<typeof startAutomaticDiscoveryRunSchema>,
) {
  const input = startAutomaticDiscoveryRunSchema.parse(raw);
  const sql = getSql();
  const rows = await sql`
    INSERT INTO automatic_discovery_runs (
      status, worker_identity, llm_provider
    ) VALUES (
      'running',
      ${input.worker_identity},
      ${input.llm_provider ?? null}
    )
    RETURNING *
  `;
  return mapRow((rows as Record<string, unknown>[])[0]);
}

export async function finishAutomaticDiscoveryRun(
  raw: z.infer<typeof finishAutomaticDiscoveryRunSchema>,
) {
  const input = finishAutomaticDiscoveryRunSchema.parse(raw);
  const sql = getSql();
  const rows = await sql`
    UPDATE automatic_discovery_runs
    SET status = ${input.status},
        completed_at = NOW(),
        metrics = ${JSON.stringify(input.metrics || {})}::jsonb,
        error_summary = ${input.error_summary ? sanitizeErrorSummary(input.error_summary) : null},
        llm_provider = COALESCE(${input.llm_provider ?? null}, llm_provider),
        updated_at = NOW()
    WHERE id = ${input.run_id}::uuid
      AND status = 'running'
    RETURNING *
  `;
  if (!(rows as unknown[]).length) {
    const existing = await sql`
      SELECT * FROM automatic_discovery_runs WHERE id = ${input.run_id}::uuid
    `;
    if (!(existing as unknown[]).length) {
      throw new Error(`automatic discovery run not found: ${input.run_id}`);
    }
    return mapRow((existing as Record<string, unknown>[])[0]);
  }
  return mapRow((rows as Record<string, unknown>[])[0]);
}

export async function getAutomaticDiscoveryStatus() {
  const sql = getSql();
  const latestRuns = await sql`
    SELECT * FROM automatic_discovery_runs
    ORDER BY started_at DESC
    LIMIT 5
  `;
  const pendingBatches = await sql`
    SELECT COUNT(*)::int AS count
    FROM discovery_inbox_batches
    WHERE status = 'pending'
  `;
  const failedBatches = await sql`
    SELECT COUNT(*)::int AS count
    FROM discovery_inbox_batches
    WHERE status = 'failed'
  `;
  const dueCompanies = await sql`
    SELECT COUNT(*)::int AS count
    FROM discovery_companies
    WHERE enabled = TRUE
      AND active_run_id IS NULL
      AND next_eligible_at <= NOW()
  `;
  const failedSources = await sql`
    SELECT COUNT(*)::int AS count
    FROM discovery_companies
    WHERE consecutive_failures > 0
  `;
  const nextScan = await sql`
    SELECT MIN(next_eligible_at) AS next_at
    FROM discovery_companies
    WHERE enabled = TRUE
  `;

  return {
    latest_runs: (latestRuns as Record<string, unknown>[]).map((row) => mapRow(row)),
    pending_batches: Number((pendingBatches as Record<string, unknown>[])[0]?.count || 0),
    failed_batches: Number((failedBatches as Record<string, unknown>[])[0]?.count || 0),
    due_companies: Number((dueCompanies as Record<string, unknown>[])[0]?.count || 0),
    failed_source_count: Number((failedSources as Record<string, unknown>[])[0]?.count || 0),
    next_scheduled_scan: (nextScan as Record<string, unknown>[])[0]?.next_at
      ? new Date(
          String((nextScan as Record<string, unknown>[])[0].next_at),
        ).toISOString()
      : null,
  };
}

export async function getStorageObservability() {
  const sql = getSql();
  const dbSize = await sql`
    SELECT pg_database_size(current_database())::bigint AS bytes
  `;
  const tableSizes = await sql`
    SELECT relname AS table_name,
           pg_total_relation_size(c.oid)::bigint AS total_bytes,
           pg_relation_size(c.oid)::bigint AS table_bytes,
           pg_indexes_size(c.oid)::bigint AS index_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND relname IN (
        'canonical_jobs', 'job_postings', 'job_evaluations',
        'discovery_gpt_evaluations', 'discovery_inbox_batches',
        'discovery_batch_effects', 'discovery_companies',
        'automatic_discovery_runs', 'applications'
      )
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;
  const jobsPerDay = await sql`
    SELECT COUNT(*)::int AS count
    FROM job_postings
    WHERE created_at >= NOW() - INTERVAL '1 day'
  `;
  const descriptionBytes = await sql`
    SELECT COALESCE(SUM(octet_length(COALESCE(description, ''))), 0)::bigint AS bytes
    FROM job_postings
  `;
  const evaluationBytes = await sql`
    SELECT COALESCE(SUM(octet_length(COALESCE(reasoning_summary, ''))), 0)::bigint AS bytes
    FROM discovery_gpt_evaluations
  `;

  const used = Number((dbSize as Record<string, unknown>[])[0]?.bytes || 0);
  return {
    database_bytes: used,
    soft_limit_bytes: DEFAULT_STORAGE_SOFT_LIMIT_BYTES,
    approaching_limit: isApproachingStorageLimit(used),
    tables: (tableSizes as Record<string, unknown>[]).map((row) => mapRow(row)),
    jobs_created_last_day: Number((jobsPerDay as Record<string, unknown>[])[0]?.count || 0),
    description_bytes: Number(
      (descriptionBytes as Record<string, unknown>[])[0]?.bytes || 0,
    ),
    evaluation_bytes: Number(
      (evaluationBytes as Record<string, unknown>[])[0]?.bytes || 0,
    ),
  };
}

export async function previewDescriptionRetention(
  raw: PreviewDescriptionRetentionInput,
) {
  const input = previewDescriptionRetentionSchema.parse(raw);
  const sql = getSql();
  const rows = await sql`
    SELECT
      p.id::text AS posting_id,
      octet_length(COALESCE(p.description, ''))::int AS description_bytes,
      p.last_seen_at,
      p.posting_status
    FROM job_postings p
    WHERE p.description IS NOT NULL
      AND length(p.description) > 0
      AND COALESCE(p.last_seen_at, p.created_at) < NOW() - make_interval(days => ${input.older_than_days})
      AND LOWER(COALESCE(p.posting_status, '')) NOT IN ('active', 'open')
      AND NOT EXISTS (
        SELECT 1 FROM applications a WHERE a.posting_id = p.id
      )
    ORDER BY COALESCE(p.last_seen_at, p.created_at) ASC
    LIMIT ${input.limit}
  `;
  const mapped = (rows as Record<string, unknown>[]).map((row) => ({
    posting_id: String(row.posting_id),
    description_bytes: Number(row.description_bytes || 0),
    last_seen_at: row.last_seen_at
      ? new Date(String(row.last_seen_at)).toISOString()
      : null,
    posting_status: row.posting_status == null ? null : String(row.posting_status),
  }));
  return {
    ...summarizeRetentionPreview(mapped),
    older_than_days: input.older_than_days,
    samples: mapped,
    cleanup_enabled: false,
  };
}

export type { ErrorCategory, ScanPriority };
