import { createHash } from "node:crypto";
import { z } from "zod";

import { getSql, getTransactionalSql, type NeonQuery } from "./client";
import {
  BLOCKING_APPLICATION_STATUSES,
  fingerprintPostingState,
  getLatestRevertEvent,
  getRevertEventByIdempotencyKey,
  listDiscoveryBatchEffects,
  type DiscoveryBatchEffectRecord,
} from "./discovery_batch_provenance";
import { getDiscoveryBatch, type DiscoveryInboxBatchRecord } from "./inbox";

export const previewDiscoveryBatchRevertSchema = z.object({
  batch_id: z.string().uuid(),
});

export const revertDiscoveryBatchSchema = z.object({
  batch_id: z.string().uuid(),
  /** Full 64-char lowercase SHA-256 preview hash; also the revert idempotency key. */
  preview_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "preview_hash must be 64-char lowercase sha256 hex"),
  requested_by: z.string().max(256).optional().nullable(),
});

export type RevertCompensationAction =
  | "none"
  | "restore_posting"
  | "withdraw_posting";

export type RevertEffectPlan = {
  effect_id: string;
  input_index: number;
  processing_action: string;
  canonical_job_id: string | null;
  posting_id: string | null;
  compensation_action: RevertCompensationAction;
  is_protected: boolean;
  protection_reasons: string[];
  before_state: Record<string, unknown> | null;
  after_fingerprint: string | null;
  current_fingerprint: string | null;
};

export type DiscoveryBatchRevertPreview = {
  batch_id: string;
  status: string;
  source: string | null;
  total_batch_jobs: number;
  effects_created_by_batch: number;
  effects_updated_or_reposted_by_batch: number;
  effects: RevertEffectPlan[];
  protected_jobs: Array<Record<string, unknown>>;
  protected_applications: Array<Record<string, unknown>>;
  records_that_would_be_restored: Array<Record<string, unknown>>;
  records_that_would_be_hidden_or_detached: Array<Record<string, unknown>>;
  preserved_evaluation_and_audit_records: {
    gpt_evaluations: "preserved";
    job_evaluations: "preserved";
    discovery_runs: "preserved";
    discovery_inbox_batch_payload: "preserved";
    application_rows: "never_deleted";
  };
  revertible: boolean;
  blocking_reasons: string[];
  preview_hash: string;
  automatic_processing_expected: boolean;
  policy: {
    partial_protection: "reject_entire_revert";
    historical_without_provenance: "not_revertible";
  };
};

export type DiscoveryBatchRevertResult = {
  ok: boolean;
  batch_id: string;
  status: string;
  preview_hash: string;
  idempotent_replay: boolean;
  compensated_effect_ids: string[];
  protected_effect_ids: string[];
  restored_postings: string[];
  withdrawn_postings: string[];
  revert_event_id: string | null;
  summary: Record<string, unknown>;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export const PREVIEW_HASH_DOMAIN = "discovery-batch-revert-v1";
export const PREVIEW_HASH_VERSION = 1;

export function buildPreviewHash(
  batchId: string,
  batchStatus: string,
  effects: RevertEffectPlan[],
): string {
  const payload = {
    domain: PREVIEW_HASH_DOMAIN,
    plan_version: PREVIEW_HASH_VERSION,
    batch_id: batchId,
    batch_status: batchStatus,
    effects: effects
      .map((effect) => ({
        effect_id: effect.effect_id,
        input_index: effect.input_index,
        processing_action: effect.processing_action,
        posting_id: effect.posting_id,
        canonical_job_id: effect.canonical_job_id,
        compensation_action: effect.compensation_action,
        is_protected: effect.is_protected,
        protection_reasons: [...effect.protection_reasons].sort(),
        after_fingerprint: effect.after_fingerprint,
        current_fingerprint: effect.current_fingerprint,
        before_fingerprint: fingerprintPostingState(effect.before_state),
        before_state: effect.before_state,
      }))
      .sort((a, b) => a.effect_id.localeCompare(b.effect_id)),
  };
  return createHash("sha256")
    .update(`${PREVIEW_HASH_DOMAIN}\n`)
    .update(stableStringify(payload))
    .digest("hex");
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function loadPosting(id: string): Promise<Record<string, unknown> | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM job_postings WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

async function loadApplicationsForPosting(
  postingId: string,
): Promise<Array<Record<string, unknown>>> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM applications
    WHERE posting_id = ${postingId}::uuid
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  });
}

async function postingReferencedByOtherBatch(
  postingId: string,
  batchId: string,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    SELECT 1
    FROM discovery_batch_effects
    WHERE posting_id = ${postingId}::uuid
      AND batch_id <> ${batchId}::uuid
    LIMIT 1
  `;
  return rows.length > 0;
}

function planCompensation(
  effect: DiscoveryBatchEffectRecord,
  protectedReasons: string[],
): RevertCompensationAction {
  if (protectedReasons.length) return "none";
  if (
    effect.processing_action === "created" ||
    effect.processing_action === "reposted"
  ) {
    if (effect.created_posting && effect.posting_id) return "withdraw_posting";
    return "none";
  }
  if (effect.processing_action === "updated") {
    if (effect.posting_id && effect.before_state) return "restore_posting";
    return "none";
  }
  return "none";
}

export async function previewDiscoveryBatchRevert(
  batchId: string,
): Promise<DiscoveryBatchRevertPreview> {
  const batch = await getDiscoveryBatch(batchId);
  const blockingReasons: string[] = [];

  if (!batch) {
    return {
      batch_id: batchId,
      status: "unknown",
      source: null,
      total_batch_jobs: 0,
      effects_created_by_batch: 0,
      effects_updated_or_reposted_by_batch: 0,
      effects: [],
      protected_jobs: [],
      protected_applications: [],
      records_that_would_be_restored: [],
      records_that_would_be_hidden_or_detached: [],
      preserved_evaluation_and_audit_records: {
        gpt_evaluations: "preserved",
        job_evaluations: "preserved",
        discovery_runs: "preserved",
        discovery_inbox_batch_payload: "preserved",
        application_rows: "never_deleted",
      },
      revertible: false,
      blocking_reasons: ["unknown_batch"],
      preview_hash: buildPreviewHash(batchId, "unknown", []),
      automatic_processing_expected: true,
      policy: {
        partial_protection: "reject_entire_revert",
        historical_without_provenance: "not_revertible",
      },
    };
  }

  if (batch.status === "pending") {
    blockingReasons.push("batch_still_pending");
  } else if (batch.status === "processing") {
    blockingReasons.push("batch_currently_processing");
  } else if (batch.status === "reverted") {
    blockingReasons.push("batch_already_reverted");
  } else if (batch.status !== "completed" && batch.status !== "failed") {
    blockingReasons.push(`unsupported_status:${batch.status}`);
  }

  const effects = await listDiscoveryBatchEffects(batchId);
  if (!effects.length) {
    blockingReasons.push("legacy_provenance_unavailable");
  }

  const plans: RevertEffectPlan[] = [];
  const protectedJobs: Array<Record<string, unknown>> = [];
  const protectedApplications: Array<Record<string, unknown>> = [];
  const restoreRecords: Array<Record<string, unknown>> = [];
  const hideRecords: Array<Record<string, unknown>> = [];

  for (const effect of effects) {
    const protectionReasons: string[] = [];
    const beforeState = parseJsonObject(effect.before_state);
    let current: Record<string, unknown> | null = null;
    let currentFingerprint: string | null = null;

    if (effect.posting_id) {
      current = await loadPosting(effect.posting_id);
      currentFingerprint = fingerprintPostingState(current);
      const apps = await loadApplicationsForPosting(effect.posting_id);
      for (const app of apps) {
        const status = String(app.status ?? "").toLowerCase();
        protectionReasons.push(`application_present:${status || "unknown"}`);
        protectedApplications.push({
          application_id: app.id,
          posting_id: effect.posting_id,
          status,
        });
        if (
          (BLOCKING_APPLICATION_STATUSES as readonly string[]).includes(status)
        ) {
          protectionReasons.push(`application_status:${status}`);
        }
      }
      if (await postingReferencedByOtherBatch(effect.posting_id, batchId)) {
        protectionReasons.push("posting_referenced_by_another_batch");
      }
      if (
        effect.after_fingerprint &&
        currentFingerprint &&
        effect.after_fingerprint !== currentFingerprint &&
        effect.processing_action !== "unchanged" &&
        effect.processing_action !== "skipped"
      ) {
        protectionReasons.push("posting_changed_since_batch");
      }
      if (!current) {
        protectionReasons.push("posting_missing");
      }
    }

    if (
      (effect.processing_action === "created" ||
        effect.processing_action === "updated" ||
        effect.processing_action === "reposted") &&
      !effect.posting_id
    ) {
      protectionReasons.push("missing_posting_id");
    }

    if (effect.processing_action === "updated" && !beforeState) {
      protectionReasons.push("missing_trustworthy_before_state");
    }

    const compensation = planCompensation(effect, protectionReasons);
    const isProtected = protectionReasons.length > 0;
    if (isProtected && effect.posting_id) {
      protectedJobs.push({
        effect_id: effect.id,
        posting_id: effect.posting_id,
        canonical_job_id: effect.canonical_job_id,
        reasons: protectionReasons,
      });
    }

    const plan: RevertEffectPlan = {
      effect_id: effect.id,
      input_index: effect.input_index,
      processing_action: effect.processing_action,
      canonical_job_id: effect.canonical_job_id,
      posting_id: effect.posting_id,
      compensation_action: compensation,
      is_protected: isProtected,
      protection_reasons: protectionReasons,
      before_state: beforeState,
      after_fingerprint: effect.after_fingerprint,
      current_fingerprint: currentFingerprint,
    };
    plans.push(plan);

    if (compensation === "restore_posting") {
      restoreRecords.push({
        effect_id: effect.id,
        posting_id: effect.posting_id,
        before_state: beforeState,
      });
    }
    if (compensation === "withdraw_posting") {
      hideRecords.push({
        effect_id: effect.id,
        posting_id: effect.posting_id,
        posting_status: "withdrawn",
      });
    }
  }

  if (plans.some((plan) => plan.is_protected)) {
    blockingReasons.push("partially_protected_batch_rejected");
  }

  const createdCount = effects.filter(
    (e) => e.processing_action === "created" || e.created_posting,
  ).length;
  const updatedCount = effects.filter(
    (e) =>
      e.processing_action === "updated" || e.processing_action === "reposted",
  ).length;

  const uniqueBlocking = [...new Set(blockingReasons)];
  const revertible = uniqueBlocking.length === 0;

  return {
    batch_id: String(batch.id),
    status: String(batch.status),
    source: batch.source == null ? null : String(batch.source),
    total_batch_jobs: Number(batch.job_count ?? 0),
    effects_created_by_batch: createdCount,
    effects_updated_or_reposted_by_batch: updatedCount,
    effects: plans,
    protected_jobs: protectedJobs,
    protected_applications: protectedApplications,
    records_that_would_be_restored: restoreRecords,
    records_that_would_be_hidden_or_detached: hideRecords,
    preserved_evaluation_and_audit_records: {
      gpt_evaluations: "preserved",
      job_evaluations: "preserved",
      discovery_runs: "preserved",
      discovery_inbox_batch_payload: "preserved",
      application_rows: "never_deleted",
    },
    revertible,
    blocking_reasons: uniqueBlocking,
    preview_hash: buildPreviewHash(String(batch.id), String(batch.status), plans),
    automatic_processing_expected: true,
    policy: {
      partial_protection: "reject_entire_revert",
      historical_without_provenance: "not_revertible",
    },
  };
}

async function runAtomicRevertStatements(
  statements: NeonQuery[],
): Promise<Array<Array<Record<string, unknown>>>> {
  // Fail closed: never sequential-fallback for destructive revert.
  const sql = getTransactionalSql();
  return sql.transaction(statements);
}

export async function revertDiscoveryBatch(input: {
  batch_id: string;
  preview_hash: string;
  requested_by?: string | null;
}): Promise<DiscoveryBatchRevertResult> {
  const idempotencyKey = input.preview_hash;
  const existing = await getRevertEventByIdempotencyKey(
    input.batch_id,
    idempotencyKey,
  );
  if (existing) {
    const batch = await getDiscoveryBatch(input.batch_id);
    return {
      ok: true,
      batch_id: input.batch_id,
      status: batch?.status == null ? "reverted" : String(batch.status),
      preview_hash: input.preview_hash,
      idempotent_replay: true,
      compensated_effect_ids: existing.compensated_effect_ids,
      protected_effect_ids: existing.protected_effect_ids,
      restored_postings: [],
      withdrawn_postings: [],
      revert_event_id: existing.id,
      summary: existing.result_summary,
    };
  }

  const preview = await previewDiscoveryBatchRevert(input.batch_id);
  if (preview.preview_hash !== input.preview_hash) {
    throw new Error("stale_or_mismatched_preview_hash");
  }

  if (!preview.revertible) {
    throw new Error(
      `batch_not_revertible: ${preview.blocking_reasons.join(",") || "unknown"}`,
    );
  }

  const sql = getTransactionalSql();
  const restored: string[] = [];
  const withdrawn: string[] = [];
  const compensated: string[] = [];
  const statements: NeonQuery[] = [];

  for (const effect of preview.effects) {
    if (!effect.posting_id || effect.compensation_action === "none") continue;

    if (effect.compensation_action === "restore_posting" && effect.before_state) {
      const before = effect.before_state;
      statements.push(sql`
        UPDATE job_postings
        SET
          description = ${ (before.description as string | null) ?? null },
          description_hash = ${ (before.description_hash as string | null) ?? null },
          location = ${ (before.location as string | null) ?? null },
          remote_status = ${ (before.remote_status as string | null) ?? null },
          salary = ${ (before.salary as string | null) ?? null },
          posted_date = ${
            before.posted_date ? new Date(String(before.posted_date)) : null
          },
          url = ${ (before.url as string | null) ?? null },
          normalized_url = ${ (before.normalized_url as string | null) ?? null },
          posting_status = ${ (before.posting_status as string | null) ?? null },
          last_seen_at = ${
            before.last_seen_at ? new Date(String(before.last_seen_at)) : null
          },
          updated_at = NOW()
        WHERE id = ${effect.posting_id}::uuid
      ` as NeonQuery);
      restored.push(effect.posting_id);
      compensated.push(effect.effect_id);
    }

    if (effect.compensation_action === "withdraw_posting") {
      statements.push(sql`
        UPDATE job_postings
        SET posting_status = 'withdrawn', updated_at = NOW()
        WHERE id = ${effect.posting_id}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM applications a
            WHERE a.posting_id = job_postings.id
              AND LOWER(COALESCE(a.status, '')) = ANY(${
                BLOCKING_APPLICATION_STATUSES as unknown as string[]
              })
          )
          AND NOT EXISTS (
            SELECT 1 FROM discovery_batch_effects e
            WHERE e.posting_id = job_postings.id
              AND e.batch_id <> ${input.batch_id}::uuid
          )
      ` as NeonQuery);
      withdrawn.push(effect.posting_id);
      compensated.push(effect.effect_id);
    }
  }

  statements.push(sql`
    UPDATE discovery_inbox_batches
    SET
      status = 'reverted',
      updated_at = NOW()
    WHERE id = ${input.batch_id}::uuid
      AND status IN ('completed', 'failed')
    RETURNING id
  ` as NeonQuery);

  const summary = {
    restored_postings: restored,
    withdrawn_postings: withdrawn,
    compensated_effect_ids: compensated,
    protected_effect_ids: [] as string[],
    preview_hash: input.preview_hash,
  };

  statements.push(sql`
    INSERT INTO discovery_batch_revert_events (
      batch_id,
      preview_hash,
      requested_by,
      result_summary,
      compensated_effect_ids,
      protected_effect_ids,
      idempotency_key
    ) VALUES (
      ${input.batch_id}::uuid,
      ${input.preview_hash},
      ${input.requested_by ?? null},
      ${JSON.stringify(summary)}::jsonb,
      ${compensated}::uuid[],
      ${[] as string[]}::uuid[],
      ${idempotencyKey}
    )
    ON CONFLICT (batch_id, idempotency_key) DO NOTHING
    RETURNING id
  ` as NeonQuery);

  const results = await runAtomicRevertStatements(statements);
  const markResult = results[results.length - 2] ?? [];
  if (!markResult.length) {
    throw new Error("revert_transaction_failed_to_mark_batch");
  }

  const insertResult = results[results.length - 1] ?? [];
  const insertedId =
    insertResult.length > 0 ? String(insertResult[0].id) : null;

  if (!insertedId) {
    const replay = await getRevertEventByIdempotencyKey(
      input.batch_id,
      idempotencyKey,
    );
    if (replay) {
      return {
        ok: true,
        batch_id: input.batch_id,
        status: "reverted",
        preview_hash: input.preview_hash,
        idempotent_replay: true,
        compensated_effect_ids: replay.compensated_effect_ids,
        protected_effect_ids: replay.protected_effect_ids,
        restored_postings: restored,
        withdrawn_postings: withdrawn,
        revert_event_id: replay.id,
        summary: replay.result_summary,
      };
    }
  }

  return {
    ok: true,
    batch_id: input.batch_id,
    status: "reverted",
    preview_hash: input.preview_hash,
    idempotent_replay: false,
    compensated_effect_ids: compensated,
    protected_effect_ids: [],
    restored_postings: restored,
    withdrawn_postings: withdrawn,
    revert_event_id: insertedId,
    summary,
  };
}

export async function enrichBatchStatusVisibility(
  batch: DiscoveryInboxBatchRecord | null,
): Promise<Record<string, unknown> | null> {
  if (!batch) return null;
  let latestRevertId: string | null = null;
  try {
    const latestRevert = await getLatestRevertEvent(String(batch.id));
    latestRevertId = latestRevert?.id ?? null;
  } catch {
    latestRevertId = null;
  }
  return {
    ...batch,
    automatic_processing_expected: true,
    automatic_processing_note:
      "Pending batches are claimed by the scheduled GitHub Actions workflow process-discovery-inbox (default every 15 minutes) or the manual CLI.",
    processing_started_at: batch.processing_started_at ?? null,
    processed_at: batch.processed_at ?? null,
    submitted_at: batch.submitted_at ?? null,
    sanitized_error: batch.error ?? null,
    latest_revert_event_id: latestRevertId,
  };
}
