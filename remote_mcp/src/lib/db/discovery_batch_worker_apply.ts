import { z } from "zod";

import { getTransactionalSql } from "./client";
import { fingerprintPostingState } from "./discovery_batch_provenance";
import {
  saveCanonicalJobSchema,
  saveJobPostingSchema,
  updateJobPostingSchema,
} from "./lifecycle";
import { saveJobEvaluationSchema } from "./evaluations";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

export const applyDiscoveryBatchJobPersistenceSchema = z.object({
  batch_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
  input_index: z.number().int().min(0),
  /** Stable per-batch per-input key, e.g. `{batch_id}:{input_index}`. */
  idempotency_key: z.string().min(8).max(256),
  processing_action: z.enum([
    "created",
    "updated",
    "reposted",
    "unchanged",
    "skipped",
  ]),
  client_candidate_id: z.string().max(128).optional().nullable(),
  company: z.string().max(512).optional().nullable(),
  title: z.string().max(512).optional().nullable(),
  source: z.string().max(128).optional().nullable(),
  external_job_id: z.string().max(256).optional().nullable(),
  normalized_url: z.string().max(2048).optional().nullable(),
  create_canonical: saveCanonicalJobSchema.optional().nullable(),
  touch_canonical_id: z.string().uuid().optional().nullable(),
  create_posting: saveJobPostingSchema
    .omit({ canonical_job_id: true })
    .extend({
      /** When true, posting uses the canonical inserted in this same transaction. */
      use_new_canonical: z.boolean().optional().default(false),
      canonical_job_id: z.string().uuid().optional(),
    })
    .optional()
    .nullable(),
  update_posting: updateJobPostingSchema.optional().nullable(),
  evaluation: saveJobEvaluationSchema
    .omit({ posting_id: true })
    .extend({
      /** When true, evaluation uses the posting upserted in this same transaction. */
      use_resolved_posting: z.boolean().optional().default(true),
      posting_id: z.string().uuid().optional(),
    })
    .optional()
    .nullable(),
  before_state: z.record(z.string(), z.unknown()).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type ApplyDiscoveryBatchJobResult = {
  ok: true;
  idempotent_replay: boolean;
  effect: Record<string, unknown>;
  canonical_job: Record<string, unknown> | null;
  job_posting: Record<string, unknown> | null;
  evaluation: Record<string, unknown> | null;
};

/**
 * Atomically persist one inbox job's lifecycle mutations + provenance effect
 * under the owning processing attempt.
 *
 * Single Neon ``sql.transaction`` containing one CTE statement so all of:
 * ownership check, mutation_started flag, canonical/posting/evaluation writes,
 * and effect insert commit together or not at all.
 *
 * Python owns scoring/lifecycle *decisions*; this tool only persists them.
 */
export async function applyDiscoveryBatchJobPersistence(
  rawInput: z.infer<typeof applyDiscoveryBatchJobPersistenceSchema>,
): Promise<ApplyDiscoveryBatchJobResult> {
  const sql = getTransactionalSql();
  const parsed = applyDiscoveryBatchJobPersistenceSchema.parse(rawInput);

  const existing = await sql`
    SELECT * FROM discovery_batch_effects
    WHERE idempotency_key = ${parsed.idempotency_key}
    LIMIT 1
  `;
  if (existing.length) {
    const prior = mapRow(existing[0] as Record<string, unknown>);
    if (String(prior.processing_action) !== parsed.processing_action) {
      throw new Error(
        `conflicting_provenance_action for idempotency_key ${parsed.idempotency_key}`,
      );
    }
    return {
      ok: true,
      idempotent_replay: true,
      effect: prior,
      canonical_job: prior.canonical_job_id
        ? { id: prior.canonical_job_id }
        : null,
      job_posting: prior.posting_id ? { id: prior.posting_id } : null,
      evaluation: prior.evaluation_id ? { id: prior.evaluation_id } : null,
    };
  }

  const conflictIndex = await sql`
    SELECT idempotency_key FROM discovery_batch_effects
    WHERE batch_id = ${parsed.batch_id}::uuid
      AND input_index = ${parsed.input_index}
    LIMIT 1
  `;
  if (conflictIndex.length) {
    throw new Error(
      `conflicting_provenance_idempotency for batch ${parsed.batch_id} input_index ${parsed.input_index}`,
    );
  }

  const willMutate = Boolean(
    parsed.create_canonical ||
      parsed.touch_canonical_id ||
      parsed.create_posting ||
      parsed.update_posting ||
      parsed.evaluation,
  );

  const beforeFingerprint = fingerprintPostingState(parsed.before_state ?? null);
  const metadataJson = JSON.stringify(parsed.metadata ?? {});
  const beforeJson = JSON.stringify(parsed.before_state ?? null);
  const evalMetaJson = JSON.stringify(parsed.evaluation?.metadata ?? {});

  const c = parsed.create_canonical;
  const p = parsed.create_posting;
  const u = parsed.update_posting;
  const e = parsed.evaluation;
  const doCreateCanonical = Boolean(c);
  const doTouchCanonical = Boolean(parsed.touch_canonical_id) && !doCreateCanonical;
  const doCreatePosting = Boolean(p);
  const doUpdatePosting = Boolean(u) && !doCreatePosting;
  const doEvaluation = Boolean(e);

  const postingCanonicalId =
    p?.use_new_canonical || doCreateCanonical
      ? null
      : (p?.canonical_job_id ?? parsed.touch_canonical_id ?? null);

  const results = await sql.transaction([
    sql`
      WITH ownership AS (
        SELECT a.id AS attempt_id
        FROM discovery_batch_processing_attempts a
        JOIN discovery_inbox_batches b ON b.id = a.batch_id
        WHERE a.id = ${parsed.attempt_id}::uuid
          AND a.batch_id = ${parsed.batch_id}::uuid
          AND a.status = 'claimed'
          AND b.status = 'processing'
          AND b.active_attempt_id = a.id
        FOR UPDATE OF a, b
      ),
      heartbeat AS (
        UPDATE discovery_batch_processing_attempts a
        SET
          mutation_started = CASE WHEN ${willMutate} THEN TRUE ELSE a.mutation_started END,
          heartbeat_at = NOW(),
          updated_at = NOW()
        FROM ownership o
        WHERE a.id = o.attempt_id
        RETURNING a.id
      ),
      new_canonical AS (
        INSERT INTO canonical_jobs (
          company, company_key, title, normalized_title,
          location, normalized_location, role_family,
          first_seen_at, last_seen_at
        )
        SELECT
          ${c?.company ?? ""},
          ${c?.company_key ?? ""},
          ${c?.title ?? ""},
          ${c?.normalized_title ?? ""},
          ${c?.location ?? null},
          ${c?.normalized_location ?? null},
          ${c?.role_family ?? null},
          NOW(),
          NOW()
        FROM ownership
        WHERE ${doCreateCanonical}
        RETURNING *
      ),
      touched_canonical AS (
        UPDATE canonical_jobs cj
        SET last_seen_at = NOW(), updated_at = NOW()
        FROM ownership
        WHERE ${doTouchCanonical}
          AND cj.id = ${parsed.touch_canonical_id ?? "00000000-0000-4000-8000-000000000000"}::uuid
        RETURNING cj.*
      ),
      resolved_canonical_id AS (
        SELECT id FROM new_canonical
        UNION ALL
        SELECT id FROM touched_canonical
        UNION ALL
        SELECT ${postingCanonicalId}::uuid AS id
        WHERE ${postingCanonicalId}::uuid IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM new_canonical)
          AND NOT EXISTS (SELECT 1 FROM touched_canonical)
      ),
      new_posting AS (
        INSERT INTO job_postings (
          canonical_job_id, source, external_job_id, url, normalized_url,
          description, description_hash, location, remote_status, salary,
          posted_date, posting_status, is_repost, supersedes_posting_id,
          first_seen_at, last_seen_at
        )
        SELECT
          (SELECT id FROM resolved_canonical_id LIMIT 1),
          ${p?.source ?? null},
          ${p?.external_job_id ?? null},
          ${p?.url ?? null},
          ${p?.normalized_url ?? null},
          ${p?.description ?? null},
          ${p?.description_hash ?? null},
          ${p?.location ?? null},
          ${p?.remote_status ?? null},
          ${p?.salary ?? null},
          ${p?.posted_date ? new Date(p.posted_date) : null},
          ${p?.posting_status ?? "active"},
          ${p?.is_repost ?? false},
          ${p?.supersedes_posting_id ?? null},
          NOW(),
          NOW()
        FROM ownership
        WHERE ${doCreatePosting}
          AND (SELECT id FROM resolved_canonical_id LIMIT 1) IS NOT NULL
        RETURNING *
      ),
      updated_posting AS (
        UPDATE job_postings jp
        SET
          last_seen_at = COALESCE(${u?.last_seen_at ? new Date(u.last_seen_at) : null}, jp.last_seen_at),
          posting_status = COALESCE(${u?.posting_status ?? null}, jp.posting_status),
          description = COALESCE(${u?.description ?? null}, jp.description),
          description_hash = COALESCE(${u?.description_hash ?? null}, jp.description_hash),
          location = COALESCE(${u?.location ?? null}, jp.location),
          remote_status = COALESCE(${u?.remote_status ?? null}, jp.remote_status),
          salary = COALESCE(${u?.salary ?? null}, jp.salary),
          posted_date = COALESCE(${u?.posted_date ? new Date(u.posted_date) : null}, jp.posted_date),
          url = COALESCE(${u?.url ?? null}, jp.url),
          normalized_url = COALESCE(${u?.normalized_url ?? null}, jp.normalized_url),
          updated_at = NOW()
        FROM ownership
        WHERE ${doUpdatePosting}
          AND jp.id = ${u?.id ?? "00000000-0000-4000-8000-000000000000"}::uuid
        RETURNING jp.*
      ),
      resolved_posting AS (
        SELECT * FROM new_posting
        UNION ALL
        SELECT * FROM updated_posting
      ),
      new_evaluation AS (
        INSERT INTO job_evaluations (
          posting_id, match_score, recommendation, reason,
          scoring_version, profile_version, metadata, evaluated_at
        )
        SELECT
          COALESCE(
            (SELECT id FROM resolved_posting LIMIT 1),
            ${e?.posting_id ?? null}::uuid
          ),
          ${e?.match_score ?? null},
          ${e?.recommendation ?? null},
          ${e?.reason ?? null},
          ${e?.scoring_version ?? null},
          ${e?.profile_version ?? null},
          ${evalMetaJson}::jsonb,
          NOW()
        FROM ownership
        WHERE ${doEvaluation}
          AND COALESCE(
            (SELECT id FROM resolved_posting LIMIT 1),
            ${e?.posting_id ?? null}::uuid
          ) IS NOT NULL
        RETURNING *
      ),
      new_effect AS (
        INSERT INTO discovery_batch_effects (
          batch_id, attempt_id, input_index, idempotency_key,
          client_candidate_id, company, title, source, external_job_id,
          normalized_url, canonical_job_id, posting_id, processing_action,
          created_canonical, created_posting, before_state, after_state,
          before_fingerprint, after_fingerprint, evaluation_id,
          evaluation_posting_id, metadata
        )
        SELECT
          ${parsed.batch_id}::uuid,
          ${parsed.attempt_id}::uuid,
          ${parsed.input_index},
          ${parsed.idempotency_key},
          ${parsed.client_candidate_id ?? null},
          ${parsed.company ?? null},
          ${parsed.title ?? null},
          ${parsed.source ?? null},
          ${parsed.external_job_id ?? null},
          ${parsed.normalized_url ?? null},
          COALESCE(
            (SELECT id FROM new_canonical LIMIT 1),
            (SELECT id FROM touched_canonical LIMIT 1),
            (SELECT canonical_job_id FROM resolved_posting LIMIT 1),
            ${parsed.touch_canonical_id ?? null}::uuid
          ),
          (SELECT id FROM resolved_posting LIMIT 1),
          ${parsed.processing_action},
          ${doCreateCanonical},
          ${doCreatePosting},
          ${beforeJson}::jsonb,
          COALESCE(
            (SELECT to_jsonb(rp.*) FROM resolved_posting rp LIMIT 1),
            'null'::jsonb
          ),
          ${beforeFingerprint},
          (
            SELECT encode(
              digest(
                concat_ws(
                  '|',
                  COALESCE(description_hash, ''),
                  COALESCE(location, ''),
                  COALESCE(remote_status, ''),
                  COALESCE(salary, ''),
                  COALESCE(posting_status, ''),
                  COALESCE(normalized_url, ''),
                  COALESCE(id::text, '')
                ),
                'sha256'
              ),
              'hex'
            )
            FROM resolved_posting
            LIMIT 1
          ),
          (SELECT id FROM new_evaluation LIMIT 1),
          (SELECT id FROM resolved_posting LIMIT 1),
          ${metadataJson}::jsonb
        FROM ownership
        RETURNING *
      )
      SELECT
        (SELECT COUNT(*)::int FROM ownership) AS owned,
        (SELECT to_jsonb(new_effect.*) FROM new_effect LIMIT 1) AS effect,
        (SELECT to_jsonb(new_canonical.*) FROM new_canonical LIMIT 1) AS new_canonical,
        (SELECT to_jsonb(touched_canonical.*) FROM touched_canonical LIMIT 1) AS touched_canonical,
        (SELECT to_jsonb(resolved_posting.*) FROM resolved_posting LIMIT 1) AS posting,
        (SELECT to_jsonb(new_evaluation.*) FROM new_evaluation LIMIT 1) AS evaluation
    `,
  ]);

  const resultRow = (results[0]?.[0] ?? null) as Record<string, unknown> | null;
  if (!resultRow || Number(resultRow.owned) < 1) {
    throw new Error("attempt_ownership_lost_or_invalid");
  }
  if (!resultRow.effect) {
    throw new Error("effect_insert_failed");
  }

  const effect =
    typeof resultRow.effect === "string"
      ? (JSON.parse(resultRow.effect) as Record<string, unknown>)
      : (resultRow.effect as Record<string, unknown>);
  const canonical =
    (resultRow.new_canonical as Record<string, unknown> | null) ||
    (resultRow.touched_canonical as Record<string, unknown> | null) ||
    null;
  const posting = (resultRow.posting as Record<string, unknown> | null) || null;
  const evaluation =
    (resultRow.evaluation as Record<string, unknown> | null) || null;

  return {
    ok: true,
    idempotent_replay: false,
    effect: mapRow(effect),
    canonical_job: canonical ? mapRow(canonical) : null,
    job_posting: posting ? mapRow(posting) : null,
    evaluation: evaluation ? mapRow(evaluation) : null,
  };
}
