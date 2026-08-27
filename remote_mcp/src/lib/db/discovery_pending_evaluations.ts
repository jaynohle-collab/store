/**
 * Durable pending evaluation queue (Milestone 5).
 * Preserves candidates when all LLM providers are unavailable.
 */

import { z } from "zod";

import { getSql, getTransactionalSql } from "./client";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

const pendingItemSchema = z
  .object({
    fingerprint: z.string().min(8).max(512),
    company_id: z.string().uuid().optional().nullable(),
    company_key: z.string().max(128).optional().nullable(),
    client_candidate_id: z.string().min(1).max(256),
    company: z.string().min(1).max(512),
    title: z.string().min(1).max(512),
    url: z.string().min(1).max(2048),
    source: z.string().min(1).max(128),
    external_job_id: z.string().max(256).optional().default(""),
    location: z.string().max(512).optional().default(""),
    posted_date: z.string().max(32).optional().default(""),
    description: z.string().min(1).max(100_000),
    description_hash: z
      .string()
      .regex(/^[a-f0-9]{16}$/, "description_hash must be 16 lowercase hex chars"),
  })
  .strict();

export const preservePendingDiscoveryEvaluationsSchema = z
  .object({
    items: z.array(pendingItemSchema).min(1).max(100),
  })
  .strict();

export const claimPendingDiscoveryEvaluationsSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    lease_minutes: z.number().int().min(5).max(180).default(30),
    worker_identity: z.string().min(1).max(128).default("automatic-discovery"),
  })
  .strict();

export const completePendingDiscoveryEvaluationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["completed", "abandoned"]).default("completed"),
    last_error: z.string().max(1000).optional().nullable(),
    worker_identity: z.string().min(1).max(128).optional(),
  })
  .strict();

export async function preservePendingDiscoveryEvaluations(
  raw: z.infer<typeof preservePendingDiscoveryEvaluationsSchema>,
) {
  const input = preservePendingDiscoveryEvaluationsSchema.parse(raw);
  const sql = getSql();
  const saved: Record<string, unknown>[] = [];

  for (const item of input.items) {
    const rows = await sql`
      INSERT INTO discovery_pending_evaluations (
        fingerprint, company_id, company_key, client_candidate_id,
        company, title, url, source, external_job_id, location, posted_date,
        description, description_hash, status, updated_at
      ) VALUES (
        ${item.fingerprint},
        ${item.company_id ?? null}::uuid,
        ${item.company_key ?? null},
        ${item.client_candidate_id},
        ${item.company},
        ${item.title},
        ${item.url},
        ${item.source},
        ${item.external_job_id ?? ""},
        ${item.location ?? ""},
        ${item.posted_date ?? ""},
        ${item.description},
        ${item.description_hash},
        'pending',
        NOW()
      )
      ON CONFLICT (fingerprint) DO UPDATE SET
        description = EXCLUDED.description,
        description_hash = EXCLUDED.description_hash,
        title = EXCLUDED.title,
        location = EXCLUDED.location,
        posted_date = EXCLUDED.posted_date,
        -- Never overwrite an in-progress or completed row back to pending blindly;
        -- only refresh content when still pending/abandoned.
        status = CASE
          WHEN discovery_pending_evaluations.status IN ('pending', 'abandoned')
            THEN 'pending'
          ELSE discovery_pending_evaluations.status
        END,
        last_error = NULL,
        updated_at = NOW()
      WHERE discovery_pending_evaluations.status IN ('pending', 'abandoned', 'in_progress')
      RETURNING *
    `;
    if ((rows as unknown[]).length) {
      saved.push(mapRow((rows as Record<string, unknown>[])[0]));
    } else {
      const existing = await sql`
        SELECT * FROM discovery_pending_evaluations
        WHERE fingerprint = ${item.fingerprint}
        LIMIT 1
      `;
      if ((existing as unknown[]).length) {
        saved.push(mapRow((existing as Record<string, unknown>[])[0]));
      }
    }
  }

  return { ok: true, saved_count: saved.length, items: saved };
}

async function claimOnePending(
  workerIdentity: string,
  leaseMinutes: number,
): Promise<Record<string, unknown> | null> {
  const sql = getTransactionalSql();
  const leaseMins = Math.min(Math.max(leaseMinutes, 5), 180);
  const results = await sql.transaction([
    sql`
      WITH picked AS (
        SELECT id
        FROM discovery_pending_evaluations
        WHERE status = 'pending'
           OR (
             status = 'in_progress'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= NOW()
           )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ),
      updated AS (
        UPDATE discovery_pending_evaluations p
        SET status = 'in_progress',
            lease_owner = ${workerIdentity},
            lease_expires_at = NOW() + make_interval(mins => ${leaseMins}),
            updated_at = NOW()
        FROM picked
        WHERE p.id = picked.id
        RETURNING p.*
      )
      SELECT * FROM updated
    `,
  ]);
  const rows = results[0] ?? [];
  if (!rows.length) return null;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function claimPendingDiscoveryEvaluations(
  raw: z.infer<typeof claimPendingDiscoveryEvaluationsSchema>,
) {
  const input = claimPendingDiscoveryEvaluationsSchema.parse(raw);
  const claimed: Record<string, unknown>[] = [];
  for (let i = 0; i < input.limit; i += 1) {
    const one = await claimOnePending(input.worker_identity, input.lease_minutes);
    if (!one) break;
    claimed.push(one);
  }
  return {
    ok: true,
    claimed_count: claimed.length,
    items: claimed,
  };
}

export async function completePendingDiscoveryEvaluation(
  raw: z.infer<typeof completePendingDiscoveryEvaluationSchema>,
) {
  const input = completePendingDiscoveryEvaluationSchema.parse(raw);
  const sql = getSql();
  const rows = await sql`
    UPDATE discovery_pending_evaluations
    SET status = ${input.status},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ${input.last_error ?? null},
        updated_at = NOW()
    WHERE id = ${input.id}::uuid
      AND status IN ('in_progress', 'pending')
    RETURNING *
  `;
  if (!(rows as unknown[]).length) {
    const existing = await sql`
      SELECT * FROM discovery_pending_evaluations WHERE id = ${input.id}::uuid
    `;
    if (!(existing as unknown[]).length) {
      throw new Error(`pending evaluation not found: ${input.id}`);
    }
    return {
      ok: true,
      idempotent_replay: true,
      item: mapRow((existing as Record<string, unknown>[])[0]),
    };
  }
  return {
    ok: true,
    idempotent_replay: false,
    item: mapRow((rows as Record<string, unknown>[])[0]),
  };
}
