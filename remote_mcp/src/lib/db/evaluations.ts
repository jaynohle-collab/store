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

export const saveJobEvaluationSchema = z.object({
  posting_id: z.string().uuid(),
  match_score: z.number().optional(),
  recommendation: z.string().max(128).optional(),
  reason: z.string().max(20_000).optional(),
  scoring_version: z.string().max(128).optional(),
  profile_version: z.string().max(128).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  evaluated_at: isoDateSchema.optional(),
});

export type JobEvaluationRecord = Record<string, unknown>;

export async function saveJobEvaluation(
  input: z.infer<typeof saveJobEvaluationSchema>,
): Promise<JobEvaluationRecord> {
  const sql = getSql();
  const metadata = JSON.stringify(input.metadata ?? {});
  const rows = await sql`
    INSERT INTO job_evaluations (
      posting_id, match_score, recommendation, reason,
      scoring_version, profile_version, metadata, evaluated_at
    ) VALUES (
      ${input.posting_id}::uuid,
      ${input.match_score ?? null},
      ${input.recommendation ?? null},
      ${input.reason ?? null},
      ${input.scoring_version ?? null},
      ${input.profile_version ?? null},
      ${metadata}::jsonb,
      ${input.evaluated_at ? new Date(input.evaluated_at) : new Date()}
    )
    RETURNING *
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function getLatestJobEvaluation(
  postingId: string,
): Promise<JobEvaluationRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_evaluations
    WHERE posting_id = ${postingId}::uuid
    ORDER BY evaluated_at DESC, created_at DESC
    LIMIT 1
  `;
  return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
}

export async function listJobEvaluations(
  postingId: string,
  limit = 50,
): Promise<JobEvaluationRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_evaluations
    WHERE posting_id = ${postingId}::uuid
    ORDER BY evaluated_at DESC, created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** Distinct-on latest evaluation join helper used by dashboard queries. */
export const LATEST_EVALUATION_SQL = `
  SELECT DISTINCT ON (posting_id) *
  FROM job_evaluations
  ORDER BY posting_id, evaluated_at DESC, created_at DESC
`;
