import { getActiveProfileId } from "../dashboard/time";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getSql, type Sql } from "./client";
import { listKeywordReviewCandidatesSchema, upsertKeywordReviewCandidatesSchema, type KeywordReviewCandidate } from "../discovery/keyword_review";

export class KeywordReviewUnavailableError extends Error {
  constructor() { super("Keyword review storage is unavailable. Migration 019 is required."); this.name = "KeywordReviewUnavailableError"; }
}
function missingMigration(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return ["42P01", "42883"].includes(e?.code ?? "") && /keyword_review/i.test(e?.message ?? "");
}
export type KeywordReviewRow = KeywordReviewCandidate & {
  id: string; profile_id: string; first_seen_at: string; last_seen_at: string;
  seen_count: number; policy_version: string; policy_fingerprint: string;
  newness: "new_to_review" | "seen_before";
};
export type KeywordReviewPage = { candidates: KeywordReviewRow[]; nextOffset: number | null; available: boolean };
export async function upsertKeywordReviewCandidates(input: z.input<typeof upsertKeywordReviewCandidatesSchema>, sql: Sql = getSql()) {
  const parsed = upsertKeywordReviewCandidatesSchema.parse(input);
  // Stable fallback makes exact retries idempotent; actual collection runs should supply a UUID.
  const hash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  const runId = parsed.run_id ?? `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  try {
    const rows = await sql`SELECT upsert_keyword_review(${parsed.profile_id}, ${parsed.policy_version}, ${parsed.policy_fingerprint}, ${runId}::uuid, ${JSON.stringify(parsed.candidates)}::jsonb) AS result`;
    return { ...(rows[0].result as { saved_count: number; new_count: number; updated_count: number }), run_id: runId };
  } catch (error) { if (missingMigration(error)) throw new KeywordReviewUnavailableError(); throw error; }
}
export async function listKeywordReviewCandidates(input: z.input<typeof listKeywordReviewCandidatesSchema> = {}, sql: Sql = getSql()): Promise<KeywordReviewPage> {
  const p = listKeywordReviewCandidatesSchema.parse(input);
  p.profileId = p.profileId ?? (process.env.KEYWORD_REVIEW_PROFILE_ID?.trim() || getActiveProfileId());
  try {
    const rows = await sql`
      SELECT id,profile_id,snapshot,policy_version,policy_fingerprint,first_seen_at,last_seen_at,seen_count
      FROM keyword_review_candidates
      WHERE (${p.profileId ?? null}::text IS NULL OR profile_id=${p.profileId ?? null})
        AND ((${p.bucket ?? null}::text IS NULL AND snapshot->>'bucket'<>'filtered') OR snapshot->>'bucket'=${p.bucket ?? null})
        AND (${p.q ?? null}::text IS NULL OR strpos(lower(concat_ws(' ',snapshot->>'title',snapshot->>'company',snapshot->>'location_text')),lower(${p.q ?? ""}))>0)
        AND (${p.newOnly ?? false}::boolean=false OR seen_count=1)
        AND (${p.freshSince ?? null}::timestamptz IS NULL OR first_seen_at>=${p.freshSince ?? null}::timestamptz)
      ORDER BY first_seen_at DESC,id DESC LIMIT ${p.limit + 1} OFFSET ${p.offset}`;
    const candidates = rows.slice(0, p.limit).map(row => ({
      ...(row.snapshot as KeywordReviewCandidate), id: String(row.id), profile_id: String(row.profile_id),
      policy_version: String(row.policy_version), policy_fingerprint: String(row.policy_fingerprint),
      first_seen_at: new Date(row.first_seen_at as string).toISOString(), last_seen_at: new Date(row.last_seen_at as string).toISOString(),
      seen_count: Number(row.seen_count), newness: Number(row.seen_count) === 1 ? "new_to_review" as const : "seen_before" as const,
    }));
    return { candidates, nextOffset: rows.length > p.limit ? p.offset+p.limit : null, available: true };
  } catch (error) { if (missingMigration(error)) return { candidates: [], nextOffset: null, available: false }; throw error; }
}
