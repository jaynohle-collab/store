/**
 * Company candidate registry for automatic discovery expansion.
 *
 * Candidates are stored separately from enabled scan targets. Python verifies
 * each candidate against the official ATS endpoint; only verified candidates
 * are promoted into discovery_companies (never duplicating a company key or an
 * ATS org). MCP stores state only — it does not crawl or verify endpoints.
 */

import { z } from "zod";

import { getSql, getTransactionalSql } from "./client";
import { sanitizeErrorSummary } from "./discovery_companies";

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

export const CANDIDATE_ATS_PROVIDERS = [
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "company_careers",
] as const;

export const CANDIDATE_DISCOVERY_SOURCES = [
  "seed_catalog",
  "posting_history",
  "application_history",
  "operator",
] as const;

/** Verification failures before a candidate is permanently rejected. */
export const MAX_VERIFICATION_ATTEMPTS = 5;

const companyKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "company_key must be a lowercase slug");

/** ATS identifiers are strict slugs; Workday uses tenant|site|host. */
const atsOrgIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._|-]{0,255}$/, "ats_org_id has unsupported characters");

const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "careers_url must be an https URL");

export const companyCandidateInputSchema = z
  .object({
    company_key: companyKeySchema,
    company_name: z.string().trim().min(1).max(512),
    ats_provider: z.enum(CANDIDATE_ATS_PROVIDERS),
    ats_org_id: atsOrgIdSchema.optional().nullable(),
    careers_url: httpsUrlSchema.optional().nullable(),
    discovery_source: z.enum(CANDIDATE_DISCOVERY_SOURCES),
    source_ref: z.string().trim().max(512).optional().nullable(),
    suggested_priority: z.enum(["high", "normal", "inactive"]).optional().default("normal"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ats_provider !== "company_careers" && !value.ats_org_id) {
      ctx.addIssue({ code: "custom", message: "ats_org_id is required for ATS providers" });
    }
    if (value.ats_provider === "company_careers" && !value.careers_url) {
      ctx.addIssue({ code: "custom", message: "careers_url is required for company_careers" });
    }
  });

export const upsertDiscoveryCompanyCandidatesSchema = z
  .object({
    candidates: z.array(companyCandidateInputSchema).min(1).max(100),
  })
  .strict();

export const claimDiscoveryCompanyCandidatesSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(5),
    lease_minutes: z.number().int().min(5).max(60).default(15),
    worker_identity: z.string().trim().min(1).max(128),
  })
  .strict();

export const recordDiscoveryCompanyVerificationSchema = z
  .object({
    candidate_id: z.string().uuid(),
    worker_identity: z.string().trim().min(1).max(128),
    outcome: z.enum(["verified", "failed", "rejected"]),
    verified_job_count: z.number().int().min(0).max(100000).optional().nullable(),
    error_category: z
      .enum([
        "rate_limit",
        "timeout",
        "not_found",
        "server_error",
        "network",
        "validation",
        "ssrf_blocked",
        "unknown",
      ])
      .optional()
      .nullable(),
    error_summary: z.string().max(1000).optional().nullable(),
  })
  .strict();

export const listDiscoveryCompanyCandidatesSchema = z
  .object({
    status: z.enum(["pending", "verifying", "verified", "failed", "rejected"]).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const listDiscoveryPostingUrlHintsSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(500),
  })
  .strict();

export type CandidateUpsertOutcome =
  | "inserted"
  | "exists"
  | "already_registered"
  | "duplicate_org";

/**
 * Idempotently register company candidates. Never overwrites an existing
 * candidate's verification state and never duplicates a registry company.
 */
export async function upsertDiscoveryCompanyCandidates(
  raw: z.input<typeof upsertDiscoveryCompanyCandidatesSchema>,
): Promise<{
  results: Array<{ company_key: string; outcome: CandidateUpsertOutcome }>;
  inserted_count: number;
}> {
  const input = upsertDiscoveryCompanyCandidatesSchema.parse(raw);
  const sql = getSql();
  const results: Array<{ company_key: string; outcome: CandidateUpsertOutcome }> = [];
  const seenOrgs = new Set<string>();
  for (const cand of input.candidates) {
    const org = cand.ats_org_id?.trim() || null;
    const orgKey = org ? `${cand.ats_provider}\0${org.toLowerCase()}` : null;
    if (orgKey && seenOrgs.has(orgKey)) {
      results.push({ company_key: cand.company_key, outcome: "duplicate_org" });
      continue;
    }
    if (orgKey) seenOrgs.add(orgKey);

    const registered = await sql`
      SELECT 1 FROM discovery_companies
      WHERE company_key = ${cand.company_key}
         OR (${org}::text IS NOT NULL
             AND ats_provider = ${cand.ats_provider}
             AND lower(ats_org_id) = lower(${org}))
      LIMIT 1
    `;
    if ((registered as unknown[]).length) {
      results.push({ company_key: cand.company_key, outcome: "already_registered" });
      continue;
    }

    const inserted = await sql`
      INSERT INTO discovery_company_candidates (
        company_key, company_name, ats_provider, ats_org_id, careers_url,
        discovery_source, source_ref, suggested_priority
      ) VALUES (
        ${cand.company_key}, ${cand.company_name}, ${cand.ats_provider}, ${org},
        ${cand.careers_url ?? null}, ${cand.discovery_source}, ${cand.source_ref ?? null},
        ${cand.suggested_priority}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if ((inserted as unknown[]).length) {
      results.push({ company_key: cand.company_key, outcome: "inserted" });
      continue;
    }
    const sameKey = await sql`
      SELECT 1 FROM discovery_company_candidates WHERE company_key = ${cand.company_key}
    `;
    results.push({
      company_key: cand.company_key,
      outcome: (sameKey as unknown[]).length ? "exists" : "duplicate_org",
    });
  }
  return {
    results,
    inserted_count: results.filter((r) => r.outcome === "inserted").length,
  };
}

/** Lease due candidates for verification (pending, retryable failures, stale leases). */
export async function claimDiscoveryCompanyCandidates(
  raw: z.input<typeof claimDiscoveryCompanyCandidatesSchema>,
) {
  const input = claimDiscoveryCompanyCandidatesSchema.parse(raw);
  const sql = getTransactionalSql();
  const results = await sql.transaction([
    sql`
      WITH picked AS (
        SELECT id
        FROM discovery_company_candidates
        WHERE (verification_status IN ('pending', 'failed') AND next_verification_at <= NOW())
           OR (verification_status = 'verifying' AND lease_expires_at <= NOW())
        ORDER BY
          CASE suggested_priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
          next_verification_at ASC,
          company_key ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      UPDATE discovery_company_candidates c
      SET verification_status = 'verifying',
          lease_owner = ${input.worker_identity},
          lease_expires_at = NOW() + make_interval(mins => ${input.lease_minutes}),
          verification_attempts = c.verification_attempts + 1,
          updated_at = NOW()
      FROM picked
      WHERE c.id = picked.id
      RETURNING c.*
    `,
  ]);
  const rows = (results[0] ?? []) as Record<string, unknown>[];
  return { claimed_count: rows.length, candidates: rows.map(mapRow) };
}

/**
 * Record a verification outcome for a leased candidate. Verified candidates are
 * promoted into discovery_companies (enabled, conservative 'normal' priority)
 * unless the key or ATS org is already registered, in which case the existing
 * company is linked and left untouched.
 */
export async function recordDiscoveryCompanyVerification(
  raw: z.input<typeof recordDiscoveryCompanyVerificationSchema>,
) {
  const input = recordDiscoveryCompanyVerificationSchema.parse(raw);
  const sql = getTransactionalSql();
  const summary = input.error_summary ? sanitizeErrorSummary(input.error_summary) : null;

  const current = await getSql()`
    SELECT * FROM discovery_company_candidates WHERE id = ${input.candidate_id}::uuid
  `;
  const row = (current as Record<string, unknown>[])[0];
  if (!row) throw new Error(`discovery company candidate not found: ${input.candidate_id}`);
  const status = String(row.verification_status);
  if (status !== "verifying") {
    if (status === input.outcome || (input.outcome === "failed" && status === "rejected")) {
      return { ok: true, idempotent_replay: true, candidate: mapRow(row) };
    }
    throw new Error(`discovery_company_candidate_not_leased:${status}`);
  }
  if (String(row.lease_owner || "") !== input.worker_identity) {
    throw new Error("discovery_company_candidate_owner_mismatch");
  }

  if (input.outcome === "verified") {
    const results = await sql.transaction([
      sql`
        WITH cand AS (
          SELECT *
          FROM discovery_company_candidates
          WHERE id = ${input.candidate_id}::uuid
            AND verification_status = 'verifying'
            AND lease_owner = ${input.worker_identity}
          FOR UPDATE
        ),
        existing AS (
          SELECT d.id
          FROM discovery_companies d, cand
          WHERE d.company_key = cand.company_key
             OR (cand.ats_org_id IS NOT NULL
                 AND d.ats_provider = cand.ats_provider
                 AND lower(d.ats_org_id) = lower(cand.ats_org_id))
          ORDER BY d.created_at ASC
          LIMIT 1
        ),
        ins AS (
          INSERT INTO discovery_companies (
            company_key, company_name, careers_url, ats_provider, ats_org_id,
            enabled, scan_priority, next_eligible_at
          )
          SELECT cand.company_key, cand.company_name, cand.careers_url, cand.ats_provider,
                 cand.ats_org_id, cand.suggested_priority <> 'inactive',
                 CASE WHEN cand.suggested_priority = 'inactive' THEN 'inactive' ELSE 'normal' END,
                 NOW()
          FROM cand
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          ON CONFLICT DO NOTHING
          RETURNING id
        )
        UPDATE discovery_company_candidates c
        SET verification_status = 'verified',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_verified_at = NOW(),
            last_error_category = NULL,
            last_error_summary = NULL,
            verified_job_count = ${input.verified_job_count ?? null},
            promoted_company_id = COALESCE(
              (SELECT id FROM ins), (SELECT id FROM existing)
            ),
            updated_at = NOW()
        FROM cand
        WHERE c.id = cand.id
        RETURNING c.*, (SELECT COUNT(*) FROM ins)::int AS promoted_new
      `,
    ]);
    const updated = (results[0] ?? []) as Record<string, unknown>[];
    if (!updated.length) throw new Error("discovery_company_candidate_lease_lost");
    const out = mapRow(updated[0]);
    const promotedNew = Number(out.promoted_new || 0) > 0;
    delete out.promoted_new;
    return { ok: true, idempotent_replay: false, promoted: promotedNew, candidate: out };
  }

  const attempts = Number(row.verification_attempts || 0);
  const finalReject =
    input.outcome === "rejected" || attempts >= MAX_VERIFICATION_ATTEMPTS;
  const backoffHours = Math.min(168, 2 ** Math.max(attempts, 1));
  const results = await sql.transaction([
    sql`
      UPDATE discovery_company_candidates
      SET verification_status = ${finalReject ? "rejected" : "failed"},
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_verified_at = NOW(),
          last_error_category = ${input.error_category ?? "unknown"},
          last_error_summary = ${summary},
          next_verification_at = NOW() + make_interval(hours => ${backoffHours}),
          updated_at = NOW()
      WHERE id = ${input.candidate_id}::uuid
        AND verification_status = 'verifying'
        AND lease_owner = ${input.worker_identity}
      RETURNING *
    `,
  ]);
  const updated = (results[0] ?? []) as Record<string, unknown>[];
  if (!updated.length) throw new Error("discovery_company_candidate_lease_lost");
  return { ok: true, idempotent_replay: false, promoted: false, candidate: mapRow(updated[0]) };
}

export async function listDiscoveryCompanyCandidates(
  raw: z.input<typeof listDiscoveryCompanyCandidatesSchema> = {},
) {
  const input = listDiscoveryCompanyCandidatesSchema.parse(raw);
  const sql = getSql();
  const rows = await sql`
    SELECT id, company_key, company_name, ats_provider, ats_org_id, careers_url,
           discovery_source, source_ref, verification_status, verification_attempts,
           next_verification_at, last_verified_at, last_error_category,
           verified_job_count, suggested_priority, promoted_company_id,
           created_at, updated_at
    FROM discovery_company_candidates
    WHERE (${input.status ?? null}::text IS NULL OR verification_status = ${input.status ?? null})
    ORDER BY updated_at DESC, company_key ASC
    LIMIT ${input.limit}
  `;
  return (rows as Record<string, unknown>[]).map(mapRow);
}

/**
 * Read-only: official ATS posting URLs already present in canonical job history
 * or GPT evidence. Python derives ATS identifiers from these authoritative URLs.
 */
export async function listDiscoveryPostingUrlHints(
  raw: z.input<typeof listDiscoveryPostingUrlHintsSchema> = {},
) {
  const input = listDiscoveryPostingUrlHintsSchema.parse(raw);
  const sql = getSql();
  const pattern =
    "^https://(boards|job-boards)\\.greenhouse\\.io/|^https://jobs\\.ashbyhq\\.com/|" +
    "^https://jobs\\.lever\\.co/|^https://[a-z0-9-]+\\.wd[0-9]+\\.myworkdayjobs\\.com/";
  const rows = await sql`
    SELECT url, company, origin FROM (
      SELECT DISTINCT ON (p.url) p.url, c.company, 'posting_history' AS origin
      FROM job_postings p
      JOIN canonical_jobs c ON c.id = p.canonical_job_id
      WHERE p.url ~* ${pattern}
      UNION ALL
      SELECT DISTINCT ON (e.url) e.url, e.company, 'posting_history' AS origin
      FROM discovery_gpt_evaluations e
      WHERE e.url ~* ${pattern}
    ) hints
    ORDER BY url
    LIMIT ${input.limit}
  `;
  return (rows as Record<string, unknown>[]).map((row) => ({
    url: String(row.url),
    company: String(row.company),
    origin: String(row.origin),
  }));
}

export async function getCompanyExpansionSummary() {
  const sql = getSql();
  const byStatus = await sql`
    SELECT verification_status, COUNT(*)::int AS n
    FROM discovery_company_candidates
    GROUP BY verification_status
  `;
  const counts: Record<string, number> = {
    pending: 0,
    verifying: 0,
    verified: 0,
    failed: 0,
    rejected: 0,
  };
  for (const row of byStatus as Record<string, unknown>[]) {
    counts[String(row.verification_status)] = Number(row.n || 0);
  }
  return counts;
}
