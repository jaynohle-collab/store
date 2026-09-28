/**
 * GPT discovery admission evaluation persistence.
 * Append-only evidence storage — does not create canonical jobs or inbox batches.
 * Latest selection uses server created_at + id (never client evaluated_at).
 * client_evaluation_id enables idempotent retries.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getSql } from "./client";
import {
  gptEvaluationIdempotencyFingerprint,
  normalizeGptEvaluationRecord,
  profileGenerationFilterSchema,
  recordDiscoveryEvaluationsSchema,
  type DiscoveryGptEvaluationInput,
  type ProfileGenerationFilter,
} from "../discovery/gpt_evaluation";
import { normalizeJobUrl } from "../discovery/normalize";
import type { PreflightGptEvaluationRow } from "../discovery/preflight";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

export type DiscoveryGptEvaluationRecord = Record<string, unknown>;

export class DiscoveryGptEvaluationConflictError extends Error {
  constructor(clientEvaluationId: string) {
    super(
      `client_evaluation_id ${clientEvaluationId} already exists with a different evaluation payload`,
    );
    this.name = "DiscoveryGptEvaluationConflictError";
  }
}

type MemoryEvaluation = DiscoveryGptEvaluationRecord & {
  id: string;
  client_evaluation_id: string;
  normalized_url: string | null;
  source: string;
  external_job_id: string | null;
  created_at: string;
  evaluated_at: string | null;
};

let memoryEvaluations: MemoryEvaluation[] = [];
let useMemoryBackend = false;
/** Test hook: delay between existence check and insert to exercise races. */
let memoryInsertDelayMs = 0;
/** Serialize memory writes so concurrent retries cannot double-insert. */
let memoryWriteChain: Promise<unknown> = Promise.resolve();

export function useInMemoryDiscoveryGptEvaluations(): void {
  useMemoryBackend = true;
  memoryEvaluations = [];
  memoryInsertDelayMs = 0;
  memoryWriteChain = Promise.resolve();
}

export function resetInMemoryDiscoveryGptEvaluations(): void {
  memoryEvaluations = [];
  memoryInsertDelayMs = 0;
  memoryWriteChain = Promise.resolve();
}

export function setMemoryGptEvaluationInsertDelayMs(ms: number): void {
  memoryInsertDelayMs = Math.max(0, ms);
}

export function getMemoryDiscoveryGptEvaluations(): MemoryEvaluation[] {
  return memoryEvaluations.map((row) => ({ ...row }));
}

/** Test helper: backdate created_at for ordering regressions. */
export function setMemoryEvaluationCreatedAt(
  evaluationId: string,
  createdAtIso: string,
): void {
  const row = memoryEvaluations.find((item) => item.id === evaluationId);
  if (!row) throw new Error(`Unknown evaluation id: ${evaluationId}`);
  row.created_at = createdAtIso;
}

function mapGptPreflightRow(row: Record<string, unknown>): PreflightGptEvaluationRow {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? "");
  const evaluatedAt =
    row.evaluated_at == null
      ? null
      : row.evaluated_at instanceof Date
        ? row.evaluated_at.toISOString()
        : String(row.evaluated_at);
  return {
    evaluation_id: String(row.id),
    gpt_relevance_score: Number(row.gpt_relevance_score),
    gpt_decision: String(row.gpt_decision) as PreflightGptEvaluationRow["gpt_decision"],
    hard_rejection_reason:
      row.hard_rejection_reason == null ? null : String(row.hard_rejection_reason),
    reasoning_summary:
      row.reasoning_summary == null ? null : String(row.reasoning_summary),
    evaluation_version: String(row.evaluation_version),
    description_hash: row.description_hash == null ? null : String(row.description_hash),
    remote_scope:
      row.remote_scope == null
        ? null
        : (String(row.remote_scope) as PreflightGptEvaluationRow["remote_scope"]),
    direct_posting_url_verified:
      row.direct_posting_url_verified == null
        ? null
        : Boolean(row.direct_posting_url_verified),
    normalization_version:
      row.normalization_version == null ? null : String(row.normalization_version),
    posting_status:
      row.posting_status == null
        ? null
        : (String(row.posting_status) as PreflightGptEvaluationRow["posting_status"]),
    posting_status_verified_at:
      row.posting_status_verified_at == null
        ? null
        : row.posting_status_verified_at instanceof Date
          ? row.posting_status_verified_at.toISOString()
          : String(row.posting_status_verified_at),
    evaluated_at: evaluatedAt,
    created_at: createdAt,
    normalized_url: row.normalized_url == null ? null : String(row.normalized_url),
    source: String(row.source),
    external_job_id: row.external_job_id == null ? null : String(row.external_job_id),
  };
}

function fingerprintFromStoredRow(row: Record<string, unknown>): string {
  const normalized: DiscoveryGptEvaluationInput & { normalized_url: string | null } = {
    client_evaluation_id: String(row.client_evaluation_id),
    client_candidate_id: String(row.client_candidate_id),
    company: String(row.company),
    title: String(row.title),
    url: String(row.url),
    source: String(row.source),
    external_job_id: row.external_job_id == null ? "" : String(row.external_job_id),
    location: row.location == null ? "" : String(row.location),
    description_hash: row.description_hash == null ? "" : String(row.description_hash),
    gpt_relevance_score: Number(row.gpt_relevance_score),
    gpt_decision: String(row.gpt_decision) as DiscoveryGptEvaluationInput["gpt_decision"],
    hard_rejection_reason:
      row.hard_rejection_reason == null ? null : String(row.hard_rejection_reason),
    reasoning_summary: String(row.reasoning_summary),
    evaluation_version: String(row.evaluation_version),
    remote_scope:
      row.remote_scope == null
        ? null
        : (String(row.remote_scope) as DiscoveryGptEvaluationInput["remote_scope"]),
    direct_posting_url_verified:
      row.direct_posting_url_verified == null
        ? null
        : Boolean(row.direct_posting_url_verified),
    normalization_version:
      row.normalization_version == null ? null : String(row.normalization_version),
    posting_status:
      row.posting_status == null
        ? null
        : (String(row.posting_status) as DiscoveryGptEvaluationInput["posting_status"]),
    posting_status_verified_at:
      row.posting_status_verified_at == null
        ? null
        : row.posting_status_verified_at instanceof Date
          ? row.posting_status_verified_at.toISOString()
          : String(row.posting_status_verified_at),
    profile_id: row.profile_id == null ? null : String(row.profile_id),
    profile_version: row.profile_version == null ? null : String(row.profile_version),
    normalized_url: row.normalized_url == null ? null : String(row.normalized_url),
  };
  return gptEvaluationIdempotencyFingerprint(normalized);
}

function toPublicRecord(row: DiscoveryGptEvaluationRecord): DiscoveryGptEvaluationRecord {
  return {
    evaluation_id: row.id,
    client_evaluation_id: row.client_evaluation_id,
    client_candidate_id: row.client_candidate_id,
    company: row.company,
    title: row.title,
    url: row.url,
    normalized_url: row.normalized_url ?? null,
    source: row.source,
    external_job_id: row.external_job_id ?? null,
    location: row.location ?? null,
    description_hash: row.description_hash ?? null,
    gpt_relevance_score: row.gpt_relevance_score,
    gpt_decision: row.gpt_decision,
    hard_rejection_reason: row.hard_rejection_reason ?? null,
    reasoning_summary: row.reasoning_summary,
    evaluation_version: row.evaluation_version,
    remote_scope: row.remote_scope ?? null,
    direct_posting_url_verified: row.direct_posting_url_verified ?? null,
    normalization_version: row.normalization_version ?? null,
    posting_status: row.posting_status ?? null,
    posting_status_verified_at: row.posting_status_verified_at ?? null,
    profile_id: row.profile_id ?? null,
    profile_version: row.profile_version ?? null,
    evaluated_at: row.evaluated_at ?? null,
    created_at: row.created_at,
  };
}

function toMemoryRow(
  normalized: DiscoveryGptEvaluationInput & { normalized_url: string | null },
  createdAt: string,
): MemoryEvaluation {
  return {
    id: randomUUID(),
    client_evaluation_id: normalized.client_evaluation_id,
    client_candidate_id: normalized.client_candidate_id,
    company: normalized.company,
    title: normalized.title,
    url: normalized.url,
    normalized_url: normalized.normalized_url,
    source: normalized.source,
    external_job_id: normalized.external_job_id || null,
    location: normalized.location || null,
    description_hash: normalized.description_hash || null,
    gpt_relevance_score: normalized.gpt_relevance_score,
    gpt_decision: normalized.gpt_decision,
    hard_rejection_reason: normalized.hard_rejection_reason ?? null,
    reasoning_summary: normalized.reasoning_summary,
    evaluation_version: normalized.evaluation_version,
    remote_scope: normalized.remote_scope ?? null,
    direct_posting_url_verified: normalized.direct_posting_url_verified ?? null,
    normalization_version: normalized.normalization_version ?? null,
    posting_status: normalized.posting_status ?? null,
    posting_status_verified_at: normalized.posting_status_verified_at ?? null,
    profile_id: normalized.profile_id ?? null,
    profile_version: normalized.profile_version ?? null,
    evaluated_at: normalized.evaluated_at ?? null,
    created_at: createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  const message = String((error as { message?: string }).message || "");
  return code === "23505" || /unique|duplicate/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordOneMemory(
  record: DiscoveryGptEvaluationInput & { normalized_url: string | null },
): Promise<DiscoveryGptEvaluationRecord> {
  const run = memoryWriteChain.then(async () => {
    const existing = memoryEvaluations.find(
      (row) => row.client_evaluation_id === record.client_evaluation_id,
    );
    if (existing) {
      if (
        fingerprintFromStoredRow(existing) !== gptEvaluationIdempotencyFingerprint(record)
      ) {
        throw new DiscoveryGptEvaluationConflictError(record.client_evaluation_id);
      }
      return toPublicRecord(existing);
    }

    await sleep(memoryInsertDelayMs);

    const raced = memoryEvaluations.find(
      (row) => row.client_evaluation_id === record.client_evaluation_id,
    );
    if (raced) {
      if (fingerprintFromStoredRow(raced) !== gptEvaluationIdempotencyFingerprint(record)) {
        throw new DiscoveryGptEvaluationConflictError(record.client_evaluation_id);
      }
      return toPublicRecord(raced);
    }

    const createdAt = new Date().toISOString();
    const row = toMemoryRow(record, createdAt);
    memoryEvaluations.push(row);
    return toPublicRecord(row);
  });
  memoryWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function recordOneSql(
  record: DiscoveryGptEvaluationInput & { normalized_url: string | null },
): Promise<DiscoveryGptEvaluationRecord> {
  const sql = getSql();
  const existingRows = await sql`
    SELECT * FROM discovery_gpt_evaluations
    WHERE client_evaluation_id = ${record.client_evaluation_id}::uuid
    LIMIT 1
  `;
  if (existingRows.length) {
    const existing = existingRows[0] as Record<string, unknown>;
    if (
      fingerprintFromStoredRow(existing) !== gptEvaluationIdempotencyFingerprint(record)
    ) {
      throw new DiscoveryGptEvaluationConflictError(record.client_evaluation_id);
    }
    return toPublicRecord(mapRow(existing));
  }

  const evaluatedAt = record.evaluated_at ? new Date(record.evaluated_at) : null;
  try {
    const rows = await sql`
      INSERT INTO discovery_gpt_evaluations (
        client_evaluation_id,
        client_candidate_id,
        company,
        title,
        url,
        normalized_url,
        source,
        external_job_id,
        location,
        description_hash,
        gpt_relevance_score,
        gpt_decision,
        hard_rejection_reason,
        reasoning_summary,
        evaluation_version,
        remote_scope,
        direct_posting_url_verified,
        normalization_version,
        posting_status,
        posting_status_verified_at,
        evaluated_at,
        profile_id,
        profile_version
      ) VALUES (
        ${record.client_evaluation_id}::uuid,
        ${record.client_candidate_id},
        ${record.company},
        ${record.title},
        ${record.url},
        ${record.normalized_url},
        ${record.source},
        ${record.external_job_id || null},
        ${record.location || null},
        ${record.description_hash || null},
        ${record.gpt_relevance_score},
        ${record.gpt_decision},
        ${record.hard_rejection_reason ?? null},
        ${record.reasoning_summary},
        ${record.evaluation_version},
        ${record.remote_scope ?? null},
        ${record.direct_posting_url_verified ?? null},
        ${record.normalization_version ?? null},
        ${record.posting_status ?? null},
        ${record.posting_status_verified_at ? new Date(record.posting_status_verified_at) : null},
        ${evaluatedAt},
        ${record.profile_id ?? null},
        ${record.profile_version ?? null}
      )
      RETURNING *
    `;
    return toPublicRecord(mapRow(rows[0] as Record<string, unknown>));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const racedRows = await sql`
      SELECT * FROM discovery_gpt_evaluations
      WHERE client_evaluation_id = ${record.client_evaluation_id}::uuid
      LIMIT 1
    `;
    if (!racedRows.length) throw error;
    const raced = racedRows[0] as Record<string, unknown>;
    if (fingerprintFromStoredRow(raced) !== gptEvaluationIdempotencyFingerprint(record)) {
      throw new DiscoveryGptEvaluationConflictError(record.client_evaluation_id);
    }
    return toPublicRecord(mapRow(raced));
  }
}

/** Persist 1–100 GPT discovery evaluations (idempotent by client_evaluation_id). */
export async function recordDiscoveryEvaluations(
  input: z.infer<typeof recordDiscoveryEvaluationsSchema>,
): Promise<{ evaluations: DiscoveryGptEvaluationRecord[] }> {
  const parsed = recordDiscoveryEvaluationsSchema.parse(input);
  const normalized = parsed.evaluations.map(normalizeGptEvaluationRecord);

  // Preserve input order; process sequentially so batch order is stable.
  const evaluations: DiscoveryGptEvaluationRecord[] = [];
  for (const record of normalized) {
    const saved = useMemoryBackend
      ? await recordOneMemory(record)
      : await recordOneSql(record);
    evaluations.push(saved);
  }
  return { evaluations };
}

export async function getDiscoveryGptEvaluationById(
  evaluationId: string,
): Promise<DiscoveryGptEvaluationRecord | null> {
  if (useMemoryBackend) {
    const row = memoryEvaluations.find((item) => item.id === evaluationId);
    return row ? toPublicRecord(row) : null;
  }
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_gpt_evaluations
    WHERE id = ${evaluationId}::uuid
    LIMIT 1
  `;
  return rows.length ? toPublicRecord(mapRow(rows[0] as Record<string, unknown>)) : null;
}

export const getDiscoveryEvaluationByClientIdSchema = z.object({
  client_evaluation_id: z.string().uuid(),
});

/** Read-only lookup by deterministic client_evaluation_id (pending-retry reuse). */
export async function getDiscoveryGptEvaluationByClientId(
  clientEvaluationId: string,
): Promise<DiscoveryGptEvaluationRecord | null> {
  const id = getDiscoveryEvaluationByClientIdSchema.parse({
    client_evaluation_id: clientEvaluationId,
  }).client_evaluation_id;

  if (useMemoryBackend) {
    const row = memoryEvaluations.find((item) => item.client_evaluation_id === id);
    return row ? toPublicRecord(row) : null;
  }
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM discovery_gpt_evaluations
    WHERE client_evaluation_id = ${id}::uuid
    LIMIT 1
  `;
  return rows.length ? toPublicRecord(mapRow(rows[0] as Record<string, unknown>)) : null;
}

function isNewerServerRecord(
  candidate: PreflightGptEvaluationRow,
  existing: PreflightGptEvaluationRow,
): boolean {
  if (candidate.created_at !== existing.created_at) {
    return candidate.created_at > existing.created_at;
  }
  return candidate.evaluation_id > existing.evaluation_id;
}

function latestByNormalizedUrl(
  rows: PreflightGptEvaluationRow[],
): Map<string, PreflightGptEvaluationRow> {
  const map = new Map<string, PreflightGptEvaluationRow>();
  for (const row of rows) {
    if (!row.normalized_url) continue;
    const existing = map.get(row.normalized_url);
    if (!existing || isNewerServerRecord(row, existing)) {
      map.set(row.normalized_url, row);
    }
  }
  return map;
}

function latestBySourceExternal(
  rows: PreflightGptEvaluationRow[],
): Map<string, PreflightGptEvaluationRow> {
  const map = new Map<string, PreflightGptEvaluationRow>();
  for (const row of rows) {
    const external = row.external_job_id?.trim();
    if (!external) continue;
    const key = `${row.source}\0${external}`;
    const existing = map.get(key);
    if (!existing || isNewerServerRecord(row, existing)) {
      map.set(key, row);
    }
  }
  return map;
}

/** Load latest GPT evaluations for preflight identity keys (read-only). */
export async function loadLatestGptEvaluationsForPreflight(params: {
  normalizedUrls: string[];
  sourceExternalKeys: string[];
  sources: string[];
  externalJobIds: string[];
  evaluationVersion?: string;
  profile?: ProfileGenerationFilter | null;
}): Promise<{
  byNormalizedUrl: Map<string, PreflightGptEvaluationRow>;
  bySourceExternal: Map<string, PreflightGptEvaluationRow>;
}> {
  const {
    normalizedUrls,
    sourceExternalKeys,
    sources,
    externalJobIds,
    evaluationVersion,
  } = params;
  const versionFilter = evaluationVersion?.trim() || null;
  const profileId = params.profile?.profile_id ?? null;
  const profileVersion = params.profile?.profile_version ?? null;
  const includeLegacy = Boolean(params.profile?.include_legacy_unversioned);

  if (useMemoryBackend) {
    const rows = memoryEvaluations
      .filter((row) => matchesProfileGeneration(row, params.profile ?? null))
      .map((row) => mapGptPreflightRow(row))
      .filter((row) => (versionFilter ? row.evaluation_version === versionFilter : true));
    const urlWanted = new Set(normalizedUrls);
    const pairWanted = new Set(sourceExternalKeys);
    const filtered = rows.filter((row) => {
      if (row.normalized_url && urlWanted.has(row.normalized_url)) return true;
      const external = row.external_job_id?.trim();
      if (external && pairWanted.has(`${row.source}\0${external}`)) return true;
      return false;
    });
    return {
      byNormalizedUrl: latestByNormalizedUrl(filtered),
      bySourceExternal: latestBySourceExternal(filtered),
    };
  }

  const byNormalizedUrl = new Map<string, PreflightGptEvaluationRow>();
  const bySourceExternal = new Map<string, PreflightGptEvaluationRow>();

  if (normalizedUrls.length) {
    const sql = getSql();
    const rows = await sql`
      SELECT DISTINCT ON (normalized_url)
        id, normalized_url, source, external_job_id, gpt_relevance_score, gpt_decision,
        hard_rejection_reason, reasoning_summary, evaluation_version, description_hash,
        remote_scope, direct_posting_url_verified, normalization_version,
        posting_status, posting_status_verified_at,
        evaluated_at, created_at
      FROM discovery_gpt_evaluations
      WHERE normalized_url = ANY(${normalizedUrls})
        AND (${versionFilter}::text IS NULL OR evaluation_version = ${versionFilter})
        AND (
          ${profileId}::text IS NULL
          OR (profile_id = ${profileId} AND profile_version = ${profileVersion})
          OR (${includeLegacy}::boolean AND profile_id IS NULL AND profile_version IS NULL)
        )
      ORDER BY normalized_url, created_at DESC, id DESC
    `;
    for (const raw of rows) {
      const row = mapGptPreflightRow(raw as Record<string, unknown>);
      if (row.normalized_url) byNormalizedUrl.set(row.normalized_url, row);
    }
  }

  if (sources.length && externalJobIds.length) {
    const sql = getSql();
    const rows = await sql`
      SELECT DISTINCT ON (source, external_job_id)
        id, normalized_url, source, external_job_id, gpt_relevance_score, gpt_decision,
        hard_rejection_reason, reasoning_summary, evaluation_version, description_hash,
        remote_scope, direct_posting_url_verified, normalization_version,
        posting_status, posting_status_verified_at,
        evaluated_at, created_at
      FROM discovery_gpt_evaluations
      WHERE source = ANY(${sources})
        AND external_job_id = ANY(${externalJobIds})
        AND (${versionFilter}::text IS NULL OR evaluation_version = ${versionFilter})
        AND (
          ${profileId}::text IS NULL
          OR (profile_id = ${profileId} AND profile_version = ${profileVersion})
          OR (${includeLegacy}::boolean AND profile_id IS NULL AND profile_version IS NULL)
        )
      ORDER BY source, external_job_id, created_at DESC, id DESC
    `;
    const wanted = new Set(sourceExternalKeys);
    for (const raw of rows) {
      const row = mapGptPreflightRow(raw as Record<string, unknown>);
      const external = row.external_job_id?.trim();
      if (!external) continue;
      const key = `${row.source}\0${external}`;
      if (wanted.has(key)) bySourceExternal.set(key, row);
    }
  }

  return { byNormalizedUrl, bySourceExternal };
}

function matchesProfileGeneration(
  row: Record<string, unknown>,
  profile: ProfileGenerationFilter | null,
): boolean {
  if (!profile) return true;
  const rowProfileId = row.profile_id == null ? null : String(row.profile_id);
  const rowProfileVersion = row.profile_version == null ? null : String(row.profile_version);
  if (rowProfileId === profile.profile_id && rowProfileVersion === profile.profile_version) {
    return true;
  }
  return (
    Boolean(profile.include_legacy_unversioned) &&
    rowProfileId === null &&
    rowProfileVersion === null
  );
}

export const lookupDiscoveryEvaluationStatesSchema = z
  .object({
    evaluation_version: z.string().min(1).max(64),
    profile: profileGenerationFilterSchema,
    candidates: z
      .array(
        z
          .object({
            client_candidate_id: z.string().min(1).max(128),
            url: z.string().min(1).max(2048),
            source: z.string().min(1).max(128),
            external_job_id: z.string().max(256).optional().default(""),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export type DiscoveryEvaluationState = {
  client_candidate_id: string;
  matched_by: "normalized_url" | "source_external_id" | null;
  evaluation: {
    evaluation_id: string;
    client_evaluation_id: string;
    gpt_decision: string;
    gpt_relevance_score: number;
    description_hash: string | null;
    evaluated_at: string | null;
    created_at: string;
    profile_id: string | null;
    profile_version: string | null;
  } | null;
  /** Evidence already attached to a pending/processing/completed inbox batch. */
  submitted_to_inbox: boolean;
};

type StateRow = {
  id: string;
  client_evaluation_id: string;
  normalized_url: string | null;
  source: string;
  external_job_id: string | null;
  gpt_decision: string;
  gpt_relevance_score: number;
  description_hash: string | null;
  evaluated_at: string | null;
  created_at: string;
  profile_id: string | null;
  profile_version: string | null;
};

function toStateRow(row: Record<string, unknown>): StateRow {
  const iso = (value: unknown) =>
    value == null ? null : value instanceof Date ? value.toISOString() : String(value);
  return {
    id: String(row.id),
    client_evaluation_id: String(row.client_evaluation_id),
    normalized_url: row.normalized_url == null ? null : String(row.normalized_url),
    source: String(row.source),
    external_job_id: row.external_job_id == null ? null : String(row.external_job_id),
    gpt_decision: String(row.gpt_decision),
    gpt_relevance_score: Number(row.gpt_relevance_score),
    description_hash: row.description_hash == null ? null : String(row.description_hash),
    evaluated_at: iso(row.evaluated_at),
    created_at: iso(row.created_at) ?? "",
    profile_id: row.profile_id == null ? null : String(row.profile_id),
    profile_version: row.profile_version == null ? null : String(row.profile_version),
  };
}

function isNewerStateRow(candidate: StateRow, existing: StateRow): boolean {
  if (candidate.created_at !== existing.created_at) {
    return candidate.created_at > existing.created_at;
  }
  return candidate.id > existing.id;
}

/**
 * Read-only: latest stored GPT evidence per candidate for one profile generation.
 * Used by the automatic producer to rank new/changed listings ahead of already
 * evaluated ones before any full-description fetch or LLM call.
 */
export async function lookupDiscoveryEvaluationStates(
  raw: z.input<typeof lookupDiscoveryEvaluationStatesSchema>,
): Promise<{ states: DiscoveryEvaluationState[] }> {
  const input = lookupDiscoveryEvaluationStatesSchema.parse(raw);
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    normalized_url: normalizeJobUrl(candidate.url),
    external_job_id: candidate.external_job_id.trim(),
  }));
  const urls = [
    ...new Set(candidates.map((c) => c.normalized_url).filter((u): u is string => Boolean(u))),
  ];
  const sources = [...new Set(candidates.filter((c) => c.external_job_id).map((c) => c.source))];
  const externals = [
    ...new Set(candidates.map((c) => c.external_job_id).filter((e) => Boolean(e))),
  ];

  let rows: StateRow[];
  if (useMemoryBackend) {
    const urlSet = new Set(urls);
    const pairSet = new Set(
      candidates.filter((c) => c.external_job_id).map((c) => `${c.source}\0${c.external_job_id}`),
    );
    rows = memoryEvaluations
      .filter((row) => row.evaluation_version === input.evaluation_version)
      .filter((row) => matchesProfileGeneration(row, input.profile))
      .filter(
        (row) =>
          (row.normalized_url && urlSet.has(row.normalized_url)) ||
          (row.external_job_id && pairSet.has(`${row.source}\0${row.external_job_id}`)),
      )
      .map((row) => toStateRow(row));
  } else {
    const sql = getSql();
    const found = await sql`
      SELECT id, client_evaluation_id, normalized_url, source, external_job_id,
             gpt_decision, gpt_relevance_score, description_hash, evaluated_at,
             created_at, profile_id, profile_version
      FROM discovery_gpt_evaluations
      WHERE evaluation_version = ${input.evaluation_version}
        AND (
          (profile_id = ${input.profile.profile_id}
            AND profile_version = ${input.profile.profile_version})
          OR (${input.profile.include_legacy_unversioned}::boolean
            AND profile_id IS NULL AND profile_version IS NULL)
        )
        AND (
          normalized_url = ANY(${urls})
          OR (source = ANY(${sources}) AND external_job_id = ANY(${externals}))
        )
    `;
    rows = (found as Record<string, unknown>[]).map(toStateRow);
  }

  const byUrl = new Map<string, StateRow>();
  const byPair = new Map<string, StateRow>();
  for (const row of rows) {
    if (row.normalized_url) {
      const existing = byUrl.get(row.normalized_url);
      if (!existing || isNewerStateRow(row, existing)) byUrl.set(row.normalized_url, row);
    }
    const external = row.external_job_id?.trim();
    if (external) {
      const key = `${row.source}\0${external}`;
      const existing = byPair.get(key);
      if (!existing || isNewerStateRow(row, existing)) byPair.set(key, row);
    }
  }

  const matches = candidates.map((candidate) => {
    const viaUrl = candidate.normalized_url ? byUrl.get(candidate.normalized_url) : undefined;
    if (viaUrl) return { candidate, row: viaUrl, matched_by: "normalized_url" as const };
    const viaPair = candidate.external_job_id
      ? byPair.get(`${candidate.source}\0${candidate.external_job_id}`)
      : undefined;
    if (viaPair) return { candidate, row: viaPair, matched_by: "source_external_id" as const };
    return { candidate, row: null, matched_by: null };
  });

  const evaluationIds = [
    ...new Set(matches.map((m) => m.row?.id).filter((id): id is string => Boolean(id))),
  ];
  const submitted = new Set<string>();
  if (evaluationIds.length && !useMemoryBackend) {
    const sql = getSql();
    const attached = await sql`
      SELECT DISTINCT j.value->'gpt_evaluation'->>'evaluation_id' AS evaluation_id
      FROM discovery_inbox_batches b
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(b.payload->'jobs') = 'array'
          THEN b.payload->'jobs' ELSE '[]'::jsonb END
      ) AS j(value)
      -- 'reverted' counts as attached: an audited revert must not be undone by
      -- automatic resubmission of the same evidence.
      WHERE b.status IN ('pending', 'processing', 'completed', 'reverted')
        AND j.value->'gpt_evaluation'->>'evaluation_id' = ANY(${evaluationIds})
    `;
    for (const row of attached as Record<string, unknown>[]) {
      if (row.evaluation_id) submitted.add(String(row.evaluation_id));
    }
  }

  return {
    states: matches.map(({ candidate, row, matched_by }) => ({
      client_candidate_id: candidate.client_candidate_id,
      matched_by,
      evaluation: row
        ? {
            evaluation_id: row.id,
            client_evaluation_id: row.client_evaluation_id,
            gpt_decision: row.gpt_decision,
            gpt_relevance_score: row.gpt_relevance_score,
            description_hash: row.description_hash,
            evaluated_at: row.evaluated_at,
            created_at: row.created_at,
            profile_id: row.profile_id,
            profile_version: row.profile_version,
          }
        : null,
      submitted_to_inbox: row ? submitted.has(row.id) : false,
    })),
  };
}

export { recordDiscoveryEvaluationsSchema } from "../discovery/gpt_evaluation";
