import { z } from "zod";

import { getSql, getTransactionalSql } from "./client";
import { getDiscoveryGptEvaluationById } from "./discovery_gpt_evaluations";
import {
  DEFAULT_GPT_EVALUATION_VERSION,
  GPT_QUALIFIED_THRESHOLD,
  discoveryQualityGatesRequireStoredEvidence,
  getRequiredDiscoveryEvaluationVersion,
  gptAdmissionAttachmentSchema,
  isDiscoveryRequireDescriptionHash,
  isDiscoveryRequireDirectPostingUrl,
  isDiscoveryRequireRemoteUs,
  isGptFitV2,
} from "../discovery/gpt_evaluation";
import { isCanonicalDescriptionHash } from "../discovery/description_hash";
import { normalizeJobUrl } from "../discovery/normalize";
import { isDeterministicallyInvalidPostingUrl } from "../discovery/posting_url";

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
  "reverted",
] as const;

/** Minutes a claim may stay in processing before bounded stale recovery. */
export function getDiscoveryInboxStaleProcessingMinutes(): number {
  const raw = process.env.DISCOVERY_INBOX_STALE_PROCESSING_MINUTES?.trim();
  if (!raw) return 60;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 5) return 60;
  return Math.min(parsed, 24 * 60);
}

export type DiscoveryInboxStatus = (typeof DISCOVERY_INBOX_STATUSES)[number];

export const ALLOWED_REMOTE_STATUSES = ["", "Remote", "Hybrid", "Onsite"] as const;

const FORBIDDEN_DISCOVERY_FIELDS = [
  "match_score",
  "score",
  "recommendation",
  "candidate_score",
  "disposition",
  "gpt_relevance_score",
  "gpt_decision",
  "hard_rejection_reason",
  "reasoning_summary",
  "evaluation_version",
  "evaluation_id",
  "remote_scope",
  "direct_posting_url_verified",
  "normalization_version",
  "posting_status",
  "posting_status_verified_at",
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
    gpt_evaluation: gptAdmissionAttachmentSchema.optional(),
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
    if (job.gpt_evaluation) {
      if (job.gpt_evaluation.gpt_relevance_score < GPT_QUALIFIED_THRESHOLD) {
        ctx.addIssue({
          code: "custom",
          message: `gpt_evaluation requires gpt_relevance_score >= ${GPT_QUALIFIED_THRESHOLD}`,
        });
      }
      if (job.gpt_evaluation.gpt_decision !== "QUALIFIED") {
        ctx.addIssue({
          code: "custom",
          message: "Rejected GPT evaluations cannot be submitted to the discovery inbox",
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

export class DiscoveryGptAdmissionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryGptAdmissionGateError";
  }
}

function storedMatchesJobIdentity(
  stored: Record<string, unknown>,
  job: z.infer<typeof discoveryJobSchema>,
): boolean {
  const jobUrl = normalizeJobUrl(job.url);
  const storedUrl =
    stored.normalized_url == null ? null : String(stored.normalized_url);
  return Boolean(jobUrl && storedUrl && jobUrl === storedUrl);
}

/** Validate optional/required GPT admission attachments against stored evidence. */
export async function assertDiscoveryJobsGptAdmissionGate(
  jobs: z.infer<typeof discoveryJobSchema>[],
): Promise<void> {
  const requireEvidence = discoveryQualityGatesRequireStoredEvidence();
  const requiredVersion = getRequiredDiscoveryEvaluationVersion();
  const requireRemoteUs = isDiscoveryRequireRemoteUs();
  const requireDirectUrl = isDiscoveryRequireDirectPostingUrl();
  const requireHash = isDiscoveryRequireDescriptionHash();

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const attachment = job.gpt_evaluation;

    if (!attachment) {
      if (requireEvidence || requiredVersion || requireRemoteUs || requireDirectUrl || requireHash) {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires gpt_evaluation when discovery quality gates are enabled`,
        );
      }
      continue;
    }

    const stored = await getDiscoveryGptEvaluationById(attachment.evaluation_id);
    if (!stored) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} references unknown evaluation_id ${attachment.evaluation_id}`,
      );
    }

    if (!storedMatchesJobIdentity(stored, job)) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} gpt_evaluation identity does not match stored evaluation ${attachment.evaluation_id}`,
      );
    }

    const storedDecision = String(stored.gpt_decision);
    const storedScore = Number(stored.gpt_relevance_score);
    const storedVersion = String(stored.evaluation_version || DEFAULT_GPT_EVALUATION_VERSION);
    const attachmentVersion =
      attachment.evaluation_version || DEFAULT_GPT_EVALUATION_VERSION;
    const storedHash =
      stored.description_hash == null ? "" : String(stored.description_hash).trim();
    const providedHash = (attachment.description_hash || "").trim();
    const storedRemote =
      stored.remote_scope == null ? null : String(stored.remote_scope);
    const storedDirect =
      stored.direct_posting_url_verified == null
        ? null
        : Boolean(stored.direct_posting_url_verified);
    const storedNorm =
      stored.normalization_version == null
        ? null
        : String(stored.normalization_version);
    const storedPostingStatus =
      stored.posting_status == null ? null : String(stored.posting_status);

    if (storedVersion !== attachmentVersion) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} evaluation_version mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }

    if (requiredVersion && storedVersion !== requiredVersion) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} requires evaluation_version=${requiredVersion} (got ${storedVersion})`,
      );
    }

    if (providedHash && storedHash && providedHash !== storedHash) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} description_hash mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }
    if (providedHash && !storedHash) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} description_hash provided but stored evaluation has none`,
      );
    }
    if (
      attachment.normalization_version &&
      storedNorm &&
      attachment.normalization_version !== storedNorm
    ) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} normalization_version mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }
    if (attachment.remote_scope && storedRemote && attachment.remote_scope !== storedRemote) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} remote_scope mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }
    if (
      attachment.direct_posting_url_verified != null &&
      storedDirect != null &&
      attachment.direct_posting_url_verified !== storedDirect
    ) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} direct_posting_url_verified mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }
    if (
      attachment.posting_status &&
      storedPostingStatus &&
      attachment.posting_status !== storedPostingStatus
    ) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} posting_status mismatch for evaluation_id ${attachment.evaluation_id}`,
      );
    }

    if (storedDecision !== "QUALIFIED") {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} references non-QUALIFIED evaluation ${attachment.evaluation_id}`,
      );
    }
    if (!(storedScore >= GPT_QUALIFIED_THRESHOLD)) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} references evaluation ${attachment.evaluation_id} with score below ${GPT_QUALIFIED_THRESHOLD}`,
      );
    }
    if (Number(attachment.gpt_relevance_score) !== storedScore) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} gpt_relevance_score does not match stored evaluation`,
      );
    }

    const enforceV2 =
      isGptFitV2(storedVersion) ||
      requireRemoteUs ||
      requireDirectUrl ||
      requireHash ||
      (requiredVersion != null && isGptFitV2(requiredVersion));

    if (
      (enforceV2 || requireDirectUrl) &&
      isDeterministicallyInvalidPostingUrl(job.url)
    ) {
      throw new DiscoveryGptAdmissionGateError(
        `Job at index ${index} URL is not a direct job posting`,
      );
    }

    if (enforceV2 || requireRemoteUs) {
      if (storedRemote !== "US_NATIONWIDE") {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires remote_scope=US_NATIONWIDE (got ${storedRemote ?? "null"})`,
        );
      }
    }

    if (enforceV2 || requireDirectUrl) {
      if (storedDirect !== true) {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires direct_posting_url_verified=true`,
        );
      }
    }

    if (enforceV2 || requireHash) {
      if (!isCanonicalDescriptionHash(storedHash)) {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires non-empty canonical description_hash on stored evaluation`,
        );
      }
      if (!storedNorm) {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires normalization_version on stored evaluation`,
        );
      }
    }

    if (enforceV2) {
      if (storedPostingStatus !== "OPEN") {
        throw new DiscoveryGptAdmissionGateError(
          `Job at index ${index} requires posting_status=OPEN (got ${storedPostingStatus ?? "null"})`,
        );
      }
    }
  }
}

export async function submitDiscoveryBatch(
  input: z.infer<typeof submitDiscoveryBatchSchema>,
): Promise<DiscoveryInboxBatchRecord> {
  assertMaxJobs(input.jobs);
  await assertDiscoveryJobsGptAdmissionGate(input.jobs);
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

/**
 * Atomically claim one pending inbox batch.
 *
 * PostgreSQL data-modifying CTEs share one snapshot: updating the same
 * ``discovery_inbox_batches`` row twice in one statement is unsupported and
 * can leave ``status = processing`` with ``active_attempt_id = NULL`` while
 * still inserting an orphan ``claimed`` attempt. This claim path therefore:
 *   1) locks exactly one pending row (FOR UPDATE SKIP LOCKED)
 *   2) inserts one claimed attempt for that row
 *   3) updates the batch **once** to processing + active_attempt_id
 * All three steps are one statement inside one Neon transaction.
 */
export async function claimDiscoveryBatch(
  id?: string,
  options?: { worker_identity?: string },
): Promise<DiscoveryInboxBatchRecord | null> {
  const sql = getTransactionalSql();
  const workerIdentity = (options?.worker_identity || "worker").trim() || "worker";

  // Explicit-ID and oldest-pending paths share the same single-UPDATE shape.
  const results = id
    ? await sql.transaction([
        sql`
          WITH picked AS (
            SELECT id
            FROM discovery_inbox_batches
            WHERE id = ${id}::uuid
              AND status = 'pending'
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          ),
          attempt AS (
            INSERT INTO discovery_batch_processing_attempts (
              batch_id, status, worker_identity, claimed_at, heartbeat_at, mutation_started
            )
            SELECT id, 'claimed', ${workerIdentity}, NOW(), NOW(), FALSE
            FROM picked
            RETURNING *
          ),
          updated AS (
            UPDATE discovery_inbox_batches b
            SET
              status = 'processing',
              processing_started_at = NOW(),
              updated_at = NOW(),
              active_attempt_id = a.id
            FROM picked p
            INNER JOIN attempt a ON a.batch_id = p.id
            WHERE b.id = p.id
              AND b.status = 'pending'
            RETURNING
              b.*,
              a.id AS attempt_id,
              a.worker_identity AS attempt_worker,
              a.mutation_started AS attempt_mutation_started
          )
          SELECT * FROM updated
        `,
      ])
    : await sql.transaction([
        sql`
          WITH picked AS (
            SELECT id
            FROM discovery_inbox_batches
            WHERE status = 'pending'
            ORDER BY submitted_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          ),
          attempt AS (
            INSERT INTO discovery_batch_processing_attempts (
              batch_id, status, worker_identity, claimed_at, heartbeat_at, mutation_started
            )
            SELECT id, 'claimed', ${workerIdentity}, NOW(), NOW(), FALSE
            FROM picked
            RETURNING *
          ),
          updated AS (
            UPDATE discovery_inbox_batches b
            SET
              status = 'processing',
              processing_started_at = NOW(),
              updated_at = NOW(),
              active_attempt_id = a.id
            FROM picked p
            INNER JOIN attempt a ON a.batch_id = p.id
            WHERE b.id = p.id
              AND b.status = 'pending'
            RETURNING
              b.*,
              a.id AS attempt_id,
              a.worker_identity AS attempt_worker,
              a.mutation_started AS attempt_mutation_started
          )
          SELECT * FROM updated
        `,
      ]);

  const rows = results[0] ?? [];
  if (!rows.length) return null;
  const row = mapRow<DiscoveryInboxBatchRecord>(rows[0] as Record<string, unknown>);
  if (!row.attempt_id) {
    // Defensive: never return a processing batch without a linked attempt id.
    throw new Error("claim_discovery_batch_missing_attempt_id");
  }
  return {
    ...row,
    attempt_id: String(row.attempt_id),
    worker_identity: String(row.attempt_worker ?? workerIdentity),
    mutation_started: Boolean(row.attempt_mutation_started),
  };
}

export async function completeDiscoveryBatch(
  id: string,
  attemptId?: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  if (!attemptId) {
    throw new Error("attempt_id_required_for_complete");
  }
  const sql = getTransactionalSql();
  // Single statement: eligibility lock gates both mutations. Neon multi-statement
  // transactions commit statement-1 even when statement-2 returns zero rows.
  const results = await sql.transaction([
    sql`
      WITH eligible AS (
        SELECT
          b.id AS batch_id,
          a.id AS attempt_id
        FROM discovery_inbox_batches b
        INNER JOIN discovery_batch_processing_attempts a
          ON a.id = b.active_attempt_id
         AND a.batch_id = b.id
        WHERE b.id = ${id}::uuid
          AND b.status = 'processing'
          AND b.active_attempt_id = ${attemptId}::uuid
          AND a.id = ${attemptId}::uuid
          AND a.status = 'claimed'
        FOR UPDATE OF b, a
      ),
      updated_batch AS (
        UPDATE discovery_inbox_batches b
        SET
          status = 'completed',
          processed_at = NOW(),
          updated_at = NOW(),
          active_attempt_id = NULL
        FROM eligible e
        WHERE b.id = e.batch_id
        RETURNING b.*
      ),
      updated_attempt AS (
        UPDATE discovery_batch_processing_attempts a
        SET
          status = 'completed',
          completed_at = NOW(),
          heartbeat_at = NOW(),
          updated_at = NOW()
        FROM eligible e
        WHERE a.id = e.attempt_id
        RETURNING a.id
      )
      SELECT ub.*
      FROM updated_batch ub
      WHERE EXISTS (SELECT 1 FROM updated_attempt)
    `,
  ]);
  const batchRows = results[0] ?? [];
  if (!batchRows.length) return null;
  return mapRow(batchRows[0] as Record<string, unknown>);
}

export async function failDiscoveryBatch(
  id: string,
  error: string,
  attemptId?: string,
): Promise<DiscoveryInboxBatchRecord | null> {
  if (!attemptId) {
    throw new Error("attempt_id_required_for_fail");
  }
  const sql = getTransactionalSql();
  const results = await sql.transaction([
    sql`
      WITH eligible AS (
        SELECT
          b.id AS batch_id,
          a.id AS attempt_id
        FROM discovery_inbox_batches b
        INNER JOIN discovery_batch_processing_attempts a
          ON a.id = b.active_attempt_id
         AND a.batch_id = b.id
        WHERE b.id = ${id}::uuid
          AND b.status = 'processing'
          AND b.active_attempt_id = ${attemptId}::uuid
          AND a.id = ${attemptId}::uuid
          AND a.status = 'claimed'
        FOR UPDATE OF b, a
      ),
      updated_batch AS (
        UPDATE discovery_inbox_batches b
        SET
          status = 'failed',
          processed_at = NOW(),
          error = ${error},
          updated_at = NOW(),
          active_attempt_id = NULL
        FROM eligible e
        WHERE b.id = e.batch_id
        RETURNING b.*
      ),
      updated_attempt AS (
        UPDATE discovery_batch_processing_attempts a
        SET
          status = 'failed',
          sanitized_error = ${error},
          completed_at = NOW(),
          heartbeat_at = NOW(),
          updated_at = NOW()
        FROM eligible e
        WHERE a.id = e.attempt_id
        RETURNING a.id
      )
      SELECT ub.*
      FROM updated_batch ub
      WHERE EXISTS (SELECT 1 FROM updated_attempt)
    `,
  ]);
  const batchRows = results[0] ?? [];
  if (!batchRows.length) return null;
  return mapRow(batchRows[0] as Record<string, unknown>);
}

/**
 * Fail-closed stale-claim recovery.
 *
 * Never infers "no mutations" from an empty effects table alone.
 * Requeue is allowed ONLY when the durable attempt proves
 * ``mutation_started = FALSE`` (set atomically with the first mutation).
 * Any mutation_started / missing-attempt / effects-present case marks the
 * batch failed for operator review — never auto-replay.
 *
 * Requeue and fail-closed transitions use one SQL statement so attempt and
 * batch mutations cannot partially commit across Neon multi-statement txs.
 */
export async function recoverStaleDiscoveryBatchClaims(
  limit = 20,
): Promise<{
  requeued: DiscoveryInboxBatchRecord[];
  failed: DiscoveryInboxBatchRecord[];
  abandoned_attempts: string[];
  stale_after_minutes: number;
  policy: "fail_closed_unless_mutation_started_false";
}> {
  const sql = getTransactionalSql();
  const minutes = getDiscoveryInboxStaleProcessingMinutes();
  const candidates = await sql`
    SELECT
      b.*,
      a.id AS attempt_id,
      a.mutation_started AS attempt_mutation_started,
      a.status AS attempt_status
    FROM discovery_inbox_batches b
    LEFT JOIN discovery_batch_processing_attempts a
      ON a.id = b.active_attempt_id
    WHERE b.status = 'processing'
      AND b.processing_started_at IS NOT NULL
      AND b.processing_started_at < NOW() - (${minutes}::text || ' minutes')::interval
    ORDER BY b.processing_started_at ASC
    LIMIT ${limit}
  `;

  const requeued: DiscoveryInboxBatchRecord[] = [];
  const failed: DiscoveryInboxBatchRecord[] = [];
  const abandonedAttempts: string[] = [];

  for (const raw of candidates) {
    const row = raw as Record<string, unknown>;
    const batchId = String(row.id);
    const attemptId = row.attempt_id == null ? null : String(row.attempt_id);
    const mutationStarted = row.attempt_mutation_started === true;

    // Proven safe: active attempt exists and never started mutations.
    if (attemptId && mutationStarted === false) {
      const abandonMessage = `stale_claim_abandoned_after_${minutes}_minutes_no_mutations`;
      const results = await sql.transaction([
        sql`
          WITH eligible AS (
            SELECT
              b.id AS batch_id,
              a.id AS attempt_id
            FROM discovery_inbox_batches b
            INNER JOIN discovery_batch_processing_attempts a
              ON a.id = b.active_attempt_id
             AND a.batch_id = b.id
            WHERE b.id = ${batchId}::uuid
              AND b.status = 'processing'
              AND b.active_attempt_id = ${attemptId}::uuid
              AND a.id = ${attemptId}::uuid
              AND a.status = 'claimed'
              AND a.mutation_started = FALSE
            FOR UPDATE OF b, a
          ),
          updated_attempt AS (
            UPDATE discovery_batch_processing_attempts a
            SET
              status = 'abandoned',
              sanitized_error = ${abandonMessage},
              completed_at = NOW(),
              updated_at = NOW()
            FROM eligible e
            WHERE a.id = e.attempt_id
            RETURNING a.id
          ),
          updated_batch AS (
            UPDATE discovery_inbox_batches b
            SET
              status = 'pending',
              processing_started_at = NULL,
              active_attempt_id = NULL,
              error = NULL,
              updated_at = NOW()
            FROM eligible e
            WHERE b.id = e.batch_id
            RETURNING b.*
          )
          SELECT ub.*
          FROM updated_batch ub
          WHERE EXISTS (SELECT 1 FROM updated_attempt)
        `,
      ]);
      if ((results[0] ?? []).length) {
        abandonedAttempts.push(attemptId);
        requeued.push(
          mapRow(results[0][0] as Record<string, unknown>),
        );
      }
      continue;
    }

    const message =
      `stale_processing_claim_timeout after ${minutes} minutes ` +
      `(fail-closed: mutation state uncertain or mutations started; operator review required)`;

    // Fail-closed: always transition the batch when still processing.
    // If a claimed attempt is still linked, abandon it in the same statement
    // so we never abandon without failing (or fail without abandoning when
    // the attempt is still claimed under the same eligibility lock).
    const results = await sql.transaction([
      sql`
        WITH eligible_batch AS (
          SELECT
            b.id AS batch_id,
            b.active_attempt_id
          FROM discovery_inbox_batches b
          WHERE b.id = ${batchId}::uuid
            AND b.status = 'processing'
          FOR UPDATE OF b
        ),
        eligible_attempt AS (
          SELECT a.id AS attempt_id
          FROM discovery_batch_processing_attempts a
          INNER JOIN eligible_batch e
            ON a.batch_id = e.batch_id
           AND a.id = e.active_attempt_id
          WHERE a.status = 'claimed'
          FOR UPDATE OF a
        ),
        updated_batch AS (
          UPDATE discovery_inbox_batches b
          SET
            status = 'failed',
            processed_at = NOW(),
            error = ${message},
            updated_at = NOW(),
            active_attempt_id = NULL
          FROM eligible_batch e
          WHERE b.id = e.batch_id
          RETURNING b.*
        ),
        updated_attempt AS (
          UPDATE discovery_batch_processing_attempts a
          SET
            status = 'abandoned',
            sanitized_error = ${message},
            completed_at = NOW(),
            updated_at = NOW()
          FROM eligible_attempt ea
          WHERE a.id = ea.attempt_id
          RETURNING a.id
        )
        SELECT
          ub.*,
          (SELECT attempt_id FROM eligible_attempt LIMIT 1) AS abandoned_attempt_id
        FROM updated_batch ub
      `,
    ]);
    if ((results[0] ?? []).length) {
      const failedRow = mapRow(results[0][0] as Record<string, unknown>);
      failed.push(failedRow);
      const abandonedId = results[0][0]?.abandoned_attempt_id;
      if (abandonedId != null) {
        abandonedAttempts.push(String(abandonedId));
      }
    }
  }

  return {
    requeued,
    failed,
    abandoned_attempts: abandonedAttempts,
    stale_after_minutes: minutes,
    policy: "fail_closed_unless_mutation_started_false",
  };
}
