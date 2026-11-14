import { z } from "zod";

const text = z.string().trim().min(1).max(500);
const phrases = z.array(z.string().max(500)).max(200);
export const keywordReviewBucketSchema = z.enum(["stronger", "broader", "needs_checking", "filtered"]);
/** Preserve unknown query parameters and fragments: either may identify a posting. */
export function normalizeKeywordReviewUrl(value: string): string {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid posting URL");
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Invalid posting URL");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // Local hygiene only, not DNS resolution, employer verification, or SSRF protection.
  // Conservatively reject all IP literals, matching the dashboard link gate.
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) throw new Error("Expected public posting hostname");
  if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host) || host === "home.arpa" || host.endsWith(".home.arpa")) throw new Error("Expected public posting hostname");
  if ((u.port && !["80", "443"].includes(u.port)) || !u.pathname.replace(/\//g, "")) throw new Error("Expected posting path on standard HTTP(S) port");
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(gclid|fbclid)$/i.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}
const url = z.string().max(4096).refine(v => { try { normalizeKeywordReviewUrl(v); return true; } catch { return false; } }, "Expected HTTP(S) URL without credentials");
const identityAliasSchema = z.object({
  normalized_url: url.transform(normalizeKeywordReviewUrl), source: text, company: text,
  external_job_id: z.string().trim().max(500).default(""),
}).strict();
export const keywordReviewCandidateSchema = z.object({
  candidate_key: z.string().regex(/^[a-f0-9]{64}$/), title: text, company: text, source: text,
  url, normalized_url: url.optional(), external_job_id: z.string().trim().max(500).optional(),
  identity_aliases: z.array(identityAliasSchema).max(500).default([]),
  location_text: z.string().max(2000), posted_date_text: z.string().max(500),
  label: z.literal("Keyword match, unverified").default("Keyword match, unverified"),
  bucket: keywordReviewBucketSchema, keyword_score: z.number().finite().min(0).max(100),
  score_components: z.record(z.string().max(100), z.number().finite().min(0).max(100)),
  matched_role_terms: phrases, matched_seniority_terms: phrases,
  matched_keyword_groups: z.array(z.object({ group: text, aliases: phrases }).strict()).max(200),
  listing_country_signal: text, listing_work_mode_signal: text,
  eligibility_status: z.literal("unverified"), open_status: z.literal("unverified"), link_status: z.literal("unverified"),
  application_action: z.literal("none"),
  application_history: z.enum(["matched", "not_found_in_supplied_snapshot", "not_checked"]),
  duplicate_count: z.number().int().min(0).max(20000), warnings: phrases, filter_reasons: phrases,
}).strict().transform(row => ({ ...row, normalized_url: normalizeKeywordReviewUrl(row.url) }));
export const upsertKeywordReviewCandidatesSchema = z.object({
  profile_id: text, policy_version: text, policy_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  run_id: z.string().uuid().optional(), candidates: z.array(keywordReviewCandidateSchema).min(1).max(100),
}).strict();
export const listKeywordReviewCandidatesSchema = z.object({
  profileId: text.optional(), q: z.string().trim().max(200).optional(), bucket: keywordReviewBucketSchema.optional(),
  newOnly: z.union([z.boolean(), z.enum(["true", "false"]).transform(v => v === "true")]).optional(),
  freshSince: z.iso.datetime({ offset: true }).optional(),
  freshBefore: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export type KeywordReviewCandidate = z.output<typeof keywordReviewCandidateSchema>;
