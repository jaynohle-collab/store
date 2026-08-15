import { z } from "zod";

import { getSql } from "./client";

const isoDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

export const saveCanonicalJobSchema = z.object({
  company: z.string().min(1).max(512),
  company_key: z.string().min(1).max(512),
  title: z.string().min(1).max(512),
  normalized_title: z.string().min(1).max(512),
  location: z.string().max(512).optional(),
  normalized_location: z.string().max(512).optional(),
  role_family: z.string().max(256).optional(),
  first_seen_at: isoDateSchema.optional(),
  last_seen_at: isoDateSchema.optional(),
});

export const saveJobPostingSchema = z.object({
  canonical_job_id: z.string().uuid(),
  source: z.string().max(256).optional(),
  external_job_id: z.string().max(512).optional(),
  url: z.string().max(2048).optional(),
  normalized_url: z.string().max(2048).optional(),
  description: z.string().max(100_000).optional(),
  description_hash: z.string().max(128).optional(),
  location: z.string().max(512).optional(),
  remote_status: z.string().max(128).optional(),
  salary: z.string().max(256).optional(),
  posted_date: isoDateSchema.optional(),
  posting_status: z.string().max(64).optional(),
  is_repost: z.boolean().optional(),
  supersedes_posting_id: z.string().uuid().optional(),
  first_seen_at: isoDateSchema.optional(),
  last_seen_at: isoDateSchema.optional(),
});

export const updateJobPostingSchema = z.object({
  id: z.string().uuid(),
  last_seen_at: isoDateSchema.optional(),
  posting_status: z.string().max(64).optional(),
  description: z.string().max(100_000).optional(),
  description_hash: z.string().max(128).optional(),
  location: z.string().max(512).optional(),
  remote_status: z.string().max(128).optional(),
  salary: z.string().max(256).optional(),
  posted_date: isoDateSchema.optional(),
  url: z.string().max(2048).optional(),
  normalized_url: z.string().max(2048).optional(),
});

export const recordApplicationSchema = z.object({
  canonical_job_id: z.string().uuid(),
  posting_id: z.string().uuid(),
  applied_at: isoDateSchema.optional(),
  status: z.string().max(64).optional(),
  application_url: z.string().max(2048).optional(),
  resume_version: z.string().max(256).optional(),
  cover_letter_version: z.string().max(256).optional(),
  notes: z.string().max(20_000).optional(),
});

export const updateApplicationStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.string().min(1).max(64),
  notes: z.string().max(20_000).optional(),
  applied_at: isoDateSchema.optional(),
});

export const addApplicationEventSchema = z.object({
  application_id: z.string().uuid(),
  event_type: z.string().min(1).max(128),
  event_at: isoDateSchema.optional(),
  notes: z.string().max(20_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const saveDiscoveryRunSchema = z.object({
  source: z.string().max(256).optional(),
  started_at: isoDateSchema.optional(),
  completed_at: isoDateSchema.optional(),
  jobs_discovered: z.number().int().min(0).optional(),
  new_jobs: z.number().int().min(0).optional(),
  reposts: z.number().int().min(0).optional(),
  duplicates: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CanonicalJobRecord = Record<string, unknown>;
export type JobPostingRecord = Record<string, unknown>;
export type ApplicationRecord = Record<string, unknown>;
export type ApplicationEventRecord = Record<string, unknown>;
export type DiscoveryRunRecord = Record<string, unknown>;

export async function saveCanonicalJob(
  input: z.infer<typeof saveCanonicalJobSchema>,
): Promise<CanonicalJobRecord> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO canonical_jobs (
      company, company_key, title, normalized_title,
      location, normalized_location, role_family,
      first_seen_at, last_seen_at
    ) VALUES (
      ${input.company},
      ${input.company_key},
      ${input.title},
      ${input.normalized_title},
      ${input.location ?? null},
      ${input.normalized_location ?? null},
      ${input.role_family ?? null},
      ${input.first_seen_at ? new Date(input.first_seen_at) : new Date()},
      ${input.last_seen_at ? new Date(input.last_seen_at) : new Date()}
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function touchCanonicalJob(id: string, lastSeenAt?: string): Promise<CanonicalJobRecord | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE canonical_jobs
    SET
      last_seen_at = ${lastSeenAt ? new Date(lastSeenAt) : new Date()},
      updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function getCanonicalJob(id: string): Promise<CanonicalJobRecord | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM canonical_jobs WHERE id = ${id}::uuid LIMIT 1`;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function findCanonicalJobsByCompanyTitle(
  companyKey: string,
  normalizedTitle: string,
  limit = 20,
): Promise<CanonicalJobRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM canonical_jobs
    WHERE company_key = ${companyKey}
      AND normalized_title = ${normalizedTitle}
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function findCanonicalJobsByCompany(
  companyKey: string,
  limit = 100,
  offset = 0,
): Promise<CanonicalJobRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM canonical_jobs
    WHERE company_key = ${companyKey}
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function saveJobPosting(
  input: z.infer<typeof saveJobPostingSchema>,
): Promise<JobPostingRecord> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO job_postings (
      canonical_job_id, source, external_job_id, url, normalized_url,
      description, description_hash, location, remote_status, salary,
      posted_date, posting_status, is_repost, supersedes_posting_id,
      first_seen_at, last_seen_at
    ) VALUES (
      ${input.canonical_job_id}::uuid,
      ${input.source ?? null},
      ${input.external_job_id ?? null},
      ${input.url ?? null},
      ${input.normalized_url ?? null},
      ${input.description ?? null},
      ${input.description_hash ?? null},
      ${input.location ?? null},
      ${input.remote_status ?? null},
      ${input.salary ?? null},
      ${input.posted_date ? new Date(input.posted_date) : null},
      ${input.posting_status ?? "active"},
      ${input.is_repost ?? false},
      ${input.supersedes_posting_id ?? null},
      ${input.first_seen_at ? new Date(input.first_seen_at) : new Date()},
      ${input.last_seen_at ? new Date(input.last_seen_at) : new Date()}
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function updateJobPosting(
  input: z.infer<typeof updateJobPostingSchema>,
): Promise<JobPostingRecord | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE job_postings
    SET
      last_seen_at = COALESCE(${input.last_seen_at ? new Date(input.last_seen_at) : null}, last_seen_at),
      posting_status = COALESCE(${input.posting_status ?? null}, posting_status),
      description = COALESCE(${input.description ?? null}, description),
      description_hash = COALESCE(${input.description_hash ?? null}, description_hash),
      location = COALESCE(${input.location ?? null}, location),
      remote_status = COALESCE(${input.remote_status ?? null}, remote_status),
      salary = COALESCE(${input.salary ?? null}, salary),
      posted_date = COALESCE(${input.posted_date ? new Date(input.posted_date) : null}, posted_date),
      url = COALESCE(${input.url ?? null}, url),
      normalized_url = COALESCE(${input.normalized_url ?? null}, normalized_url),
      updated_at = NOW()
    WHERE id = ${input.id}::uuid
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function getJobPosting(id: string): Promise<JobPostingRecord | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM job_postings WHERE id = ${id}::uuid LIMIT 1`;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function findJobPostingByNormalizedUrl(
  normalizedUrl: string,
): Promise<JobPostingRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_postings
    WHERE normalized_url = ${normalizedUrl}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function findJobPostingBySourceExternalId(
  source: string,
  externalJobId: string,
): Promise<JobPostingRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_postings
    WHERE source = ${source}
      AND external_job_id = ${externalJobId}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function listPostingsForCanonical(
  canonicalJobId: string,
  limit = 50,
): Promise<JobPostingRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_postings
    WHERE canonical_job_id = ${canonicalJobId}::uuid
    ORDER BY COALESCE(posted_date, first_seen_at) DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function searchJobPostings(
  query: string,
  limit: number,
  offset = 0,
): Promise<{ postings: JobPostingRecord[]; nextOffset: number | null }> {
  const sql = getSql();
  const pattern = `%${query}%`;
  const fetchLimit = limit + 1;
  const rows = await sql`
    SELECT p.*, c.company, c.title AS canonical_title
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    WHERE
      c.company ILIKE ${pattern}
      OR c.title ILIKE ${pattern}
      OR COALESCE(p.url, '') ILIKE ${pattern}
      OR COALESCE(p.external_job_id, '') ILIKE ${pattern}
      OR COALESCE(p.description, '') ILIKE ${pattern}
    ORDER BY p.last_seen_at DESC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;
  const hasMore = rows.length > limit;
  const postings = rows.slice(0, limit).map((row) => mapRow(row as Record<string, unknown>));
  return { postings, nextOffset: hasMore ? offset + postings.length : null };
}

export async function listRecentPostings(
  days: number,
  limit: number,
  offset = 0,
): Promise<{ postings: JobPostingRecord[]; nextOffset: number | null }> {
  const sql = getSql();
  const fetchLimit = limit + 1;
  const rows = await sql`
    SELECT p.*, c.company, c.title AS canonical_title
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    WHERE p.first_seen_at >= NOW() - (${days}::text || ' days')::interval
    ORDER BY p.first_seen_at DESC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;
  const hasMore = rows.length > limit;
  const postings = rows.slice(0, limit).map((row) => mapRow(row as Record<string, unknown>));
  return { postings, nextOffset: hasMore ? offset + postings.length : null };
}

export async function recordApplication(
  input: z.infer<typeof recordApplicationSchema>,
): Promise<ApplicationRecord> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO applications (
      canonical_job_id, posting_id, applied_at, status,
      application_url, resume_version, cover_letter_version, notes
    ) VALUES (
      ${input.canonical_job_id}::uuid,
      ${input.posting_id}::uuid,
      ${input.applied_at ? new Date(input.applied_at) : null},
      ${input.status ?? "planned"},
      ${input.application_url ?? null},
      ${input.resume_version ?? null},
      ${input.cover_letter_version ?? null},
      ${input.notes ?? null}
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function getApplication(id: string): Promise<ApplicationRecord | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM applications WHERE id = ${id}::uuid LIMIT 1`;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function listApplications(params: {
  status?: string;
  canonicalJobId?: string;
  postingId?: string;
  limit?: number;
}): Promise<ApplicationRecord[]> {
  const sql = getSql();
  const limit = params.limit ?? 50;
  const rows = await sql`
    SELECT * FROM applications
    WHERE (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null})
      AND (${params.canonicalJobId ?? null}::uuid IS NULL OR canonical_job_id = ${params.canonicalJobId ?? null}::uuid)
      AND (${params.postingId ?? null}::uuid IS NULL OR posting_id = ${params.postingId ?? null}::uuid)
    ORDER BY COALESCE(applied_at, created_at) DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function updateApplicationStatus(
  input: z.infer<typeof updateApplicationStatusSchema>,
): Promise<ApplicationRecord | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE applications
    SET
      status = ${input.status},
      notes = COALESCE(${input.notes ?? null}, notes),
      applied_at = COALESCE(${input.applied_at ? new Date(input.applied_at) : null}, applied_at),
      updated_at = NOW()
    WHERE id = ${input.id}::uuid
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function addApplicationEvent(
  input: z.infer<typeof addApplicationEventSchema>,
): Promise<ApplicationEventRecord> {
  const sql = getSql();
  const metadata = JSON.stringify(input.metadata ?? {});
  const rows = await sql`
    INSERT INTO application_events (
      application_id, event_type, event_at, notes, metadata
    ) VALUES (
      ${input.application_id}::uuid,
      ${input.event_type},
      ${input.event_at ? new Date(input.event_at) : new Date()},
      ${input.notes ?? null},
      ${metadata}::jsonb
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function listApplicationEvents(
  applicationId: string,
): Promise<ApplicationEventRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM application_events
    WHERE application_id = ${applicationId}::uuid
    ORDER BY event_at ASC, created_at ASC
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function saveDiscoveryRun(
  input: z.infer<typeof saveDiscoveryRunSchema>,
): Promise<DiscoveryRunRecord> {
  const sql = getSql();
  const metadata = JSON.stringify(input.metadata ?? {});
  const rows = await sql`
    INSERT INTO discovery_runs (
      source, started_at, completed_at,
      jobs_discovered, new_jobs, reposts, duplicates, metadata
    ) VALUES (
      ${input.source ?? null},
      ${input.started_at ? new Date(input.started_at) : new Date()},
      ${input.completed_at ? new Date(input.completed_at) : null},
      ${input.jobs_discovered ?? 0},
      ${input.new_jobs ?? 0},
      ${input.reposts ?? 0},
      ${input.duplicates ?? 0},
      ${metadata}::jsonb
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function listDiscoveryRuns(limit = 20): Promise<DiscoveryRunRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** Dashboard-oriented read models (no business decisions). */
export async function listRepostedPostings(limit = 50): Promise<JobPostingRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT p.*, c.company, c.title AS canonical_title
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    WHERE p.is_repost = TRUE
    ORDER BY p.first_seen_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function listRepostsWithPriorApplications(limit = 50): Promise<JobPostingRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT DISTINCT ON (p.id)
      p.*,
      c.company,
      c.title AS canonical_title,
      prior.id AS prior_application_id,
      prior.status AS prior_application_status,
      prior.posting_id AS prior_posting_id
    FROM job_postings p
    JOIN canonical_jobs c ON c.id = p.canonical_job_id
    JOIN applications prior
      ON prior.canonical_job_id = p.canonical_job_id
     AND prior.posting_id <> p.id
    WHERE p.is_repost = TRUE
    ORDER BY p.id, prior.applied_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}
