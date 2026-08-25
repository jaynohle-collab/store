import { createHash } from "node:crypto";
import { z } from "zod";

import { getSql } from "./client";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value == null
        ? null
        : value instanceof Date
          ? value.toISOString()
          : value;
  }
  return out as T;
}

export const PROCESSING_ACTIONS = [
  "created",
  "updated",
  "reposted",
  "unchanged",
  "skipped",
] as const;

export type ProcessingAction = (typeof PROCESSING_ACTIONS)[number];

export const discoveryBatchEffectInputSchema = z.object({
  input_index: z.number().int().min(0),
  client_candidate_id: z.string().max(128).optional().nullable(),
  company: z.string().max(512).optional().nullable(),
  title: z.string().max(512).optional().nullable(),
  source: z.string().max(128).optional().nullable(),
  external_job_id: z.string().max(256).optional().nullable(),
  normalized_url: z.string().max(2048).optional().nullable(),
  canonical_job_id: z.string().uuid().optional().nullable(),
  posting_id: z.string().uuid().optional().nullable(),
  processing_action: z.enum(PROCESSING_ACTIONS),
  created_canonical: z.boolean().default(false),
  created_posting: z.boolean().default(false),
  before_state: z.record(z.string(), z.unknown()).optional().nullable(),
  after_state: z.record(z.string(), z.unknown()).optional().nullable(),
  after_fingerprint: z.string().max(128).optional().nullable(),
  evaluation_posting_id: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const recordDiscoveryBatchEffectsSchema = z.object({
  batch_id: z.string().uuid(),
  effects: z.array(discoveryBatchEffectInputSchema).min(0).max(100),
});

export type DiscoveryBatchEffectRecord = {
  id: string;
  batch_id: string;
  input_index: number;
  client_candidate_id: string | null;
  company: string | null;
  title: string | null;
  source: string | null;
  external_job_id: string | null;
  normalized_url: string | null;
  canonical_job_id: string | null;
  posting_id: string | null;
  processing_action: ProcessingAction;
  created_canonical: boolean;
  created_posting: boolean;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  after_fingerprint: string | null;
  evaluation_posting_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DiscoveryBatchRevertEventRecord = {
  id: string;
  batch_id: string;
  preview_hash: string;
  requested_by: string | null;
  result_summary: Record<string, unknown>;
  compensated_effect_ids: string[];
  protected_effect_ids: string[];
  idempotency_key: string;
  created_at: string;
};

export function fingerprintPostingState(
  state: Record<string, unknown> | null | undefined,
): string | null {
  if (!state) return null;
  const keys = [
    "id",
    "canonical_job_id",
    "url",
    "normalized_url",
    "description_hash",
    "location",
    "remote_status",
    "salary",
    "posted_date",
    "posting_status",
    "last_seen_at",
    "is_repost",
  ] as const;
  const slim: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in state) slim[key] = state[key] ?? null;
  }
  return createHash("sha256")
    .update(JSON.stringify(slim))
    .digest("hex")
    .slice(0, 32);
}

function normalizeJson(
  value: Record<string, unknown> | null | undefined,
): string {
  if (!value) return "null";
  return JSON.stringify(value);
}

export async function recordDiscoveryBatchEffects(
  input: z.infer<typeof recordDiscoveryBatchEffectsSchema>,
): Promise<DiscoveryBatchEffectRecord[]> {
  const sql = getSql();
  const batchRows = await sql`
    SELECT id, status FROM discovery_inbox_batches
    WHERE id = ${input.batch_id}::uuid
    LIMIT 1
  `;
  if (!batchRows.length) {
    throw new Error(`Unknown discovery batch ${input.batch_id}`);
  }
  const status = String((batchRows[0] as { status: string }).status);
  if (status !== "processing" && status !== "completed" && status !== "failed") {
    throw new Error(
      `Cannot record effects for batch in status '${status}' (expected processing|completed|failed)`,
    );
  }

  const recorded: DiscoveryBatchEffectRecord[] = [];
  for (const effect of input.effects) {
    const afterFingerprint =
      effect.after_fingerprint ??
      fingerprintPostingState(effect.after_state ?? null);
    const rows = await sql`
      INSERT INTO discovery_batch_effects (
        batch_id,
        input_index,
        client_candidate_id,
        company,
        title,
        source,
        external_job_id,
        normalized_url,
        canonical_job_id,
        posting_id,
        processing_action,
        created_canonical,
        created_posting,
        before_state,
        after_state,
        after_fingerprint,
        evaluation_posting_id,
        metadata
      ) VALUES (
        ${input.batch_id}::uuid,
        ${effect.input_index},
        ${effect.client_candidate_id ?? null},
        ${effect.company ?? null},
        ${effect.title ?? null},
        ${effect.source ?? null},
        ${effect.external_job_id ?? null},
        ${effect.normalized_url ?? null},
        ${effect.canonical_job_id ?? null},
        ${effect.posting_id ?? null},
        ${effect.processing_action},
        ${effect.created_canonical ?? false},
        ${effect.created_posting ?? false},
        ${normalizeJson(effect.before_state ?? null)}::jsonb,
        ${normalizeJson(effect.after_state ?? null)}::jsonb,
        ${afterFingerprint},
        ${effect.evaluation_posting_id ?? null},
        ${normalizeJson(effect.metadata ?? {})}::jsonb
      )
      ON CONFLICT (batch_id, input_index) DO UPDATE SET
        client_candidate_id = EXCLUDED.client_candidate_id,
        company = EXCLUDED.company,
        title = EXCLUDED.title,
        source = EXCLUDED.source,
        external_job_id = EXCLUDED.external_job_id,
        normalized_url = EXCLUDED.normalized_url,
        canonical_job_id = EXCLUDED.canonical_job_id,
        posting_id = EXCLUDED.posting_id,
        processing_action = EXCLUDED.processing_action,
        created_canonical = EXCLUDED.created_canonical,
        created_posting = EXCLUDED.created_posting,
        before_state = EXCLUDED.before_state,
        after_state = EXCLUDED.after_state,
        after_fingerprint = EXCLUDED.after_fingerprint,
        evaluation_posting_id = EXCLUDED.evaluation_posting_id,
        metadata = EXCLUDED.metadata
      WHERE discovery_batch_effects.processing_action IS NOT DISTINCT FROM EXCLUDED.processing_action
        AND discovery_batch_effects.posting_id IS NOT DISTINCT FROM EXCLUDED.posting_id
        AND discovery_batch_effects.canonical_job_id IS NOT DISTINCT FROM EXCLUDED.canonical_job_id
        AND discovery_batch_effects.after_fingerprint IS NOT DISTINCT FROM EXCLUDED.after_fingerprint
      RETURNING *
    `;
    if (!rows.length) {
      const existing = await sql`
        SELECT * FROM discovery_batch_effects
        WHERE batch_id = ${input.batch_id}::uuid
          AND input_index = ${effect.input_index}
        LIMIT 1
      `;
      if (!existing.length) {
        throw new Error(
          `Failed to record effect for batch ${input.batch_id} input_index ${effect.input_index}`,
        );
      }
      const prior = mapRow<DiscoveryBatchEffectRecord>(
        existing[0] as Record<string, unknown>,
      );
      if (
        prior.processing_action !== effect.processing_action ||
        prior.posting_id !== (effect.posting_id ?? null) ||
        prior.canonical_job_id !== (effect.canonical_job_id ?? null) ||
        prior.after_fingerprint !== afterFingerprint
      ) {
        throw new Error(
          `Conflicting provenance for batch ${input.batch_id} input_index ${effect.input_index}`,
        );
      }
      recorded.push(prior);
      continue;
    }
    recorded.push(
      mapRow<DiscoveryBatchEffectRecord>(rows[0] as Record<string, unknown>),
    );
  }
  return recorded;
}

export async function listDiscoveryBatchEffects(
  batchId: string,
): Promise<DiscoveryBatchEffectRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_batch_effects
    WHERE batch_id = ${batchId}::uuid
    ORDER BY input_index ASC, created_at ASC, id ASC
  `;
  return rows.map((row) =>
    mapRow<DiscoveryBatchEffectRecord>(row as Record<string, unknown>),
  );
}

export async function getLatestRevertEvent(
  batchId: string,
): Promise<DiscoveryBatchRevertEventRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_batch_revert_events
    WHERE batch_id = ${batchId}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  return mapRevertEvent(rows[0] as Record<string, unknown>);
}

export async function getRevertEventByIdempotencyKey(
  batchId: string,
  idempotencyKey: string,
): Promise<DiscoveryBatchRevertEventRecord | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_batch_revert_events
    WHERE batch_id = ${batchId}::uuid
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  if (!rows.length) return null;
  return mapRevertEvent(rows[0] as Record<string, unknown>);
}

function mapRevertEvent(row: Record<string, unknown>): DiscoveryBatchRevertEventRecord {
  const mapped = mapRow<DiscoveryBatchRevertEventRecord>(row);
  const compensated = row.compensated_effect_ids;
  const protectedIds = row.protected_effect_ids;
  mapped.compensated_effect_ids = Array.isArray(compensated)
    ? compensated.map(String)
    : [];
  mapped.protected_effect_ids = Array.isArray(protectedIds)
    ? protectedIds.map(String)
    : [];
  if (typeof mapped.result_summary === "string") {
    try {
      mapped.result_summary = JSON.parse(mapped.result_summary) as Record<
        string,
        unknown
      >;
    } catch {
      mapped.result_summary = {};
    }
  }
  return mapped;
}

export const PROTECTED_APPLICATION_STATUSES = [
  "applied",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
] as const;

/** Later-stage statuses that permanently block revert of that posting. */
export const BLOCKING_APPLICATION_STATUSES = [
  "applied",
  "interviewing",
  "offer",
  "accepted",
] as const;
