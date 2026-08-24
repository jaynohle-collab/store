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
  recordDiscoveryEvaluationsSchema,
  type DiscoveryGptEvaluationInput,
} from "../discovery/gpt_evaluation";
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
        evaluated_at
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
        ${evaluatedAt}
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
}): Promise<{
  byNormalizedUrl: Map<string, PreflightGptEvaluationRow>;
  bySourceExternal: Map<string, PreflightGptEvaluationRow>;
}> {
  const { normalizedUrls, sourceExternalKeys, sources, externalJobIds } = params;

  if (useMemoryBackend) {
    const rows = memoryEvaluations.map((row) => mapGptPreflightRow(row));
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
        evaluated_at, created_at
      FROM discovery_gpt_evaluations
      WHERE normalized_url = ANY(${normalizedUrls})
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
        evaluated_at, created_at
      FROM discovery_gpt_evaluations
      WHERE source = ANY(${sources})
        AND external_job_id = ANY(${externalJobIds})
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

export { recordDiscoveryEvaluationsSchema } from "../discovery/gpt_evaluation";
