import { z } from "zod";

import { getSql } from "./client";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

export const DISCOVERY_INBOX_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export type DiscoveryInboxStatus = (typeof DISCOVERY_INBOX_STATUSES)[number];

export const ALLOWED_REMOTE_STATUSES = ["", "Remote", "Hybrid", "Onsite"] as const;

const FORBIDDEN_DISCOVERY_FIELDS = [
  "match_score",
  "score",
  "recommendation",
  "candidate_score",
  "disposition",
] as const;

const postedDateSchema = z.string().refine((value) => {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "posted_date must be YYYY-MM-DD or empty");

const requiredTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must be a non-empty string");

export const discoveryJobSchema = z
  .object({
    company: requiredTextSchema,
    title: requiredTextSchema,
    url: requiredTextSchema,
    location: z.string(),
    source: z.string(),
    description: requiredTextSchema,
    required_skills: z.array(z.string()),
    preferred_skills: z.array(z.string()),
    remote_status: z.enum(ALLOWED_REMOTE_STATUSES),
    salary: z.string(),
    posted_date: postedDateSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    for (const field of FORBIDDEN_DISCOVERY_FIELDS) {
      if (field in job) {
        ctx.addIssue({
          code: "custom",
          message: `Discovery jobs must not include '${field}'`,
        });
      }
    }
  });

export function getMaxDiscoveryJobs(): number {
  const raw = process.env.DISCOVERY_MAX_JOBS?.trim();
  if (!raw) return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 100;
  return Math.floor(parsed);
}

export const submitDiscoveryBatchSchema = z.object({
  jobs: z.array(discoveryJobSchema),
  source: z.string().min(1).max(256).default("chatgpt"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type DiscoveryInboxBatchRecord = Record<string, unknown>;

function assertMaxJobs(jobs: unknown[]): void {
  const max = getMaxDiscoveryJobs();
  if (jobs.length > max) {
    throw new Error(`Discovery batch has ${jobs.length} jobs which exceeds DISCOVERY_MAX_JOBS=${max}`);
  }
}

export async function submitDiscoveryBatch(
  input: z.infer<typeof submitDiscoveryBatchSchema>,
): Promise<DiscoveryInboxBatchRecord> {
  assertMaxJobs(input.jobs);
  const sql = getSql();
  const payload = JSON.stringify({ jobs: input.jobs });
  const metadata = JSON.stringify(input.metadata ?? {});
  const rows = await sql`
    INSERT INTO discovery_inbox_batches (
      source, status, payload, job_count, submitted_at, metadata
    ) VALUES (
      ${input.source},
      'pending',
      ${payload}::jsonb,
      ${input.jobs.length},
      NOW(),
      ${metadata}::jsonb
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function getDiscoveryBatch(
  id: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_inbox_batches
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function listPendingDiscoveryBatches(
  limit = 20,
): Promise<DiscoveryInboxBatchRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_inbox_batches
    WHERE status = 'pending'
    ORDER BY submitted_at ASC, created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function claimDiscoveryBatch(
  id?: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  const sql = getSql();
  if (id) {
    const rows = await sql`
      UPDATE discovery_inbox_batches
      SET
        status = 'processing',
        processing_started_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}::uuid
        AND status = 'pending'
      RETURNING *
    `;
    return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
  }

  const rows = await sql`
    UPDATE discovery_inbox_batches
    SET
      status = 'processing',
      processing_started_at = NOW(),
      updated_at = NOW()
    WHERE id = (
      SELECT id FROM discovery_inbox_batches
      WHERE status = 'pending'
      ORDER BY submitted_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function completeDiscoveryBatch(
  id: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE discovery_inbox_batches
    SET
      status = 'completed',
      processed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${id}::uuid
      AND status = 'processing'
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function failDiscoveryBatch(
  id: string,
  error: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE discovery_inbox_batches
    SET
      status = 'failed',
      processed_at = NOW(),
      error = ${error},
      updated_at = NOW()
    WHERE id = ${id}::uuid
      AND status = 'processing'
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}
