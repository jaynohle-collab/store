/**
 * Discovery preflight identity resolution (read-only).
 * Does not score, classify SAME_POSTING/REPOST/NEW_JOB, or mutate data.
 */

import { z } from "zod";

import { APPLIED_OR_LATER_STATUSES } from "../dashboard/constants";
import {
  normalizeCompanyKey,
  normalizeJobUrl,
  normalizeLocationKey,
  normalizeTitleKey,
} from "./normalize";

const FORBIDDEN_CANDIDATE_FIELDS = [
  "match_score",
  "score",
  "recommendation",
  "reason",
  "reasoning",
  "disposition",
  "candidate_score",
] as const;

const requiredTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must be a non-empty string");

/** Matches discovery inbox: empty string or YYYY-MM-DD. */
export const discoveryPreflightPostedDateSchema = z.string().refine((value) => {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "posted_date must be YYYY-MM-DD or empty");

export const discoveryPreflightCandidateSchema = z
  .object({
    client_candidate_id: requiredTextSchema,
    company: requiredTextSchema,
    title: requiredTextSchema,
    url: requiredTextSchema,
    source: requiredTextSchema,
    external_job_id: z.string(),
    location: z.string(),
    posted_date: discoveryPreflightPostedDateSchema,
    description_hash: z.string(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    for (const field of FORBIDDEN_CANDIDATE_FIELDS) {
      if (field in candidate) {
        ctx.addIssue({
          code: "custom",
          message: `Discovery preflight candidates must not include '${field}'`,
        });
      }
    }
  });

export const checkDiscoveryCandidatesSchema = z
  .object({
    candidates: z.array(discoveryPreflightCandidateSchema).min(1).max(100),
  })
  .strict();

export type DiscoveryPreflightCandidate = z.infer<typeof discoveryPreflightCandidateSchema>;
export type CheckDiscoveryCandidatesInput = z.infer<typeof checkDiscoveryCandidatesSchema>;

export type IdentityStatus =
  | "KNOWN_UNCHANGED"
  | "UPDATED_POSTING"
  | "POSSIBLE_CROSS_SOURCE"
  | "UNSEEN";

export type MatchedBy =
  | "normalized_url"
  | "source_external_id"
  | "canonical_signals"
  | "none";

export type PriorEvaluationSummary = {
  match_score: number | null;
  recommendation: string | null;
  reason: string | null;
  scoring_version: string | null;
  profile_version: string | null;
};

export type DiscoveryPreflightResult = {
  client_candidate_id: string;
  identity_status: IdentityStatus;
  matched_by: MatchedBy;
  posting_id: string | null;
  canonical_job_id: string | null;
  existing_source: string | null;
  existing_url: string | null;
  existing_description_hash: string | null;
  previously_applied: boolean;
  prior_evaluation: PriorEvaluationSummary | null;
};

export type NormalizedPreflightCandidate = DiscoveryPreflightCandidate & {
  normalized_url: string | null;
  company_key: string;
  normalized_title: string;
  normalized_location: string;
  external_job_id_key: string | null;
};

export type PreflightPostingRow = {
  id: string;
  canonical_job_id: string;
  source: string | null;
  external_job_id: string | null;
  url: string | null;
  normalized_url: string | null;
  description_hash: string | null;
  location: string | null;
};

export type PreflightCanonicalRow = {
  id: string;
  company_key: string;
  normalized_title: string;
  location: string | null;
  normalized_location: string | null;
};

export type PreflightApplicationRow = {
  posting_id: string;
  canonical_job_id: string;
  status: string | null;
};

export type PreflightEvaluationRow = {
  posting_id: string;
  match_score: number | null;
  recommendation: string | null;
  reason: string | null;
  scoring_version: string | null;
  profile_version: string | null;
};

export type DiscoveryPreflightIndex = {
  postingsByNormalizedUrl: Map<string, PreflightPostingRow>;
  postingsBySourceExternal: Map<string, PreflightPostingRow>;
  canonicalsByCompanyTitle: Map<string, PreflightCanonicalRow[]>;
  postingsByCanonicalId: Map<string, PreflightPostingRow[]>;
  postingsByCompanyHash: Map<string, PreflightPostingRow[]>;
  applicationsByPostingId: Map<string, PreflightApplicationRow[]>;
  applicationsByCanonicalId: Map<string, PreflightApplicationRow[]>;
  evaluationsByPostingId: Map<string, PreflightEvaluationRow>;
};

export function normalizePreflightCandidate(
  candidate: DiscoveryPreflightCandidate,
): NormalizedPreflightCandidate {
  const external = candidate.external_job_id.trim();
  return {
    ...candidate,
    normalized_url: normalizeJobUrl(candidate.url),
    company_key: normalizeCompanyKey(candidate.company),
    normalized_title: normalizeTitleKey(candidate.title),
    normalized_location: normalizeLocationKey(candidate.location),
    external_job_id_key: external ? external : null,
  };
}

export function sourceExternalKey(source: string, externalJobId: string): string {
  return `${source}\0${externalJobId}`;
}

export function companyTitleKey(companyKey: string, normalizedTitle: string): string {
  return `${companyKey}\0${normalizedTitle}`;
}

export function companyHashKey(companyKey: string, descriptionHash: string): string {
  return `${companyKey}\0${descriptionHash}`;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length ? text : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function mapEvaluationSummary(
  row: PreflightEvaluationRow | null | undefined,
): PriorEvaluationSummary | null {
  if (!row) return null;
  return {
    match_score: asNumber(row.match_score),
    recommendation: asString(row.recommendation),
    reason: asString(row.reason),
    scoring_version: asString(row.scoring_version),
    profile_version: asString(row.profile_version),
  };
}

function hasApplicationOnPosting(
  index: DiscoveryPreflightIndex,
  postingId: string,
): boolean {
  return (index.applicationsByPostingId.get(postingId) || []).length > 0;
}

function hasPriorAppliedOnCanonical(
  index: DiscoveryPreflightIndex,
  canonicalJobId: string,
): boolean {
  const apps = index.applicationsByCanonicalId.get(canonicalJobId) || [];
  return apps.some((app) =>
    (APPLIED_OR_LATER_STATUSES as readonly string[]).includes(
      String(app.status || "").toLowerCase(),
    ),
  );
}

function previouslyAppliedFor(
  index: DiscoveryPreflightIndex,
  postingId: string | null,
  canonicalJobId: string | null,
): boolean {
  if (postingId && hasApplicationOnPosting(index, postingId)) return true;
  if (canonicalJobId && hasPriorAppliedOnCanonical(index, canonicalJobId)) return true;
  return false;
}

function resultFromPosting(
  candidate: NormalizedPreflightCandidate,
  posting: PreflightPostingRow,
  matchedBy: "normalized_url" | "source_external_id",
  index: DiscoveryPreflightIndex,
): DiscoveryPreflightResult {
  const candidateHash = candidate.description_hash.trim();
  const existingHash = asString(posting.description_hash);
  let identityStatus: IdentityStatus = "KNOWN_UNCHANGED";
  if (candidateHash && existingHash && candidateHash !== existingHash) {
    identityStatus = "UPDATED_POSTING";
  }

  const postingId = String(posting.id);
  const canonicalJobId = String(posting.canonical_job_id);
  return {
    client_candidate_id: candidate.client_candidate_id,
    identity_status: identityStatus,
    matched_by: matchedBy,
    posting_id: postingId,
    canonical_job_id: canonicalJobId,
    existing_source: asString(posting.source),
    existing_url: asString(posting.url),
    existing_description_hash: existingHash,
    previously_applied: previouslyAppliedFor(index, postingId, canonicalJobId),
    prior_evaluation: mapEvaluationSummary(index.evaluationsByPostingId.get(postingId)),
  };
}

function pickCanonicalSignalPosting(
  candidate: NormalizedPreflightCandidate,
  canonical: PreflightCanonicalRow,
  index: DiscoveryPreflightIndex,
): PreflightPostingRow | null {
  const postings = index.postingsByCanonicalId.get(String(canonical.id)) || [];
  if (!postings.length) return null;

  const candidateHash = candidate.description_hash.trim();
  if (candidateHash) {
    const hashHit = postings.find(
      (p) => asString(p.description_hash) === candidateHash,
    );
    if (hashHit) return hashHit;
  }

  if (candidate.normalized_location) {
    const locHit = postings.find((p) => {
      const loc = normalizeLocationKey(p.location);
      return loc && loc === candidate.normalized_location;
    });
    if (locHit) return locHit;
  }

  return postings[0] ?? null;
}

function findCanonicalSignalMatch(
  candidate: NormalizedPreflightCandidate,
  index: DiscoveryPreflightIndex,
): { canonical: PreflightCanonicalRow; posting: PreflightPostingRow | null } | null {
  const titleKey = companyTitleKey(candidate.company_key, candidate.normalized_title);
  const byTitle = index.canonicalsByCompanyTitle.get(titleKey) || [];
  if (byTitle.length) {
    const canonical = byTitle[0];
    return {
      canonical,
      posting: pickCanonicalSignalPosting(candidate, canonical, index),
    };
  }

  const hash = candidate.description_hash.trim();
  if (hash) {
    const hashKey = companyHashKey(candidate.company_key, hash);
    const hashPostings = index.postingsByCompanyHash.get(hashKey) || [];
    // Same company + identical description hash on a different source/url.
    const cross = hashPostings.find((p) => {
      const sameUrl =
        candidate.normalized_url &&
        p.normalized_url &&
        candidate.normalized_url === p.normalized_url;
      const sameExternal =
        candidate.external_job_id_key &&
        p.external_job_id &&
        p.source === candidate.source &&
        p.external_job_id === candidate.external_job_id_key;
      return !sameUrl && !sameExternal;
    });
    if (cross) {
      const canonicalList =
        index.canonicalsByCompanyTitle.get(
          companyTitleKey(candidate.company_key, candidate.normalized_title),
        ) || [];
      // Prefer canonical from posting; synthesize minimal row if needed.
      const canonical: PreflightCanonicalRow = {
        id: String(cross.canonical_job_id),
        company_key: candidate.company_key,
        normalized_title: candidate.normalized_title,
        location: cross.location,
        normalized_location: normalizeLocationKey(cross.location),
      };
      if (canonicalList[0]) {
        return { canonical: canonicalList[0], posting: cross };
      }
      return { canonical, posting: cross };
    }
  }

  return null;
}

/** Pure identity resolution against a preloaded index (order-preserving). */
export function resolveDiscoveryPreflightResults(
  candidates: DiscoveryPreflightCandidate[],
  index: DiscoveryPreflightIndex,
): DiscoveryPreflightResult[] {
  return candidates.map((raw) => {
    const candidate = normalizePreflightCandidate(raw);

    if (candidate.normalized_url) {
      const byUrl = index.postingsByNormalizedUrl.get(candidate.normalized_url);
      if (byUrl) {
        return resultFromPosting(candidate, byUrl, "normalized_url", index);
      }
    }

    if (candidate.external_job_id_key) {
      const key = sourceExternalKey(candidate.source, candidate.external_job_id_key);
      const byExternal = index.postingsBySourceExternal.get(key);
      if (byExternal) {
        return resultFromPosting(candidate, byExternal, "source_external_id", index);
      }
    }

    const soft = findCanonicalSignalMatch(candidate, index);
    if (soft) {
      const posting = soft.posting;
      const postingId = posting ? String(posting.id) : null;
      const canonicalJobId = String(soft.canonical.id);
      return {
        client_candidate_id: candidate.client_candidate_id,
        identity_status: "POSSIBLE_CROSS_SOURCE",
        matched_by: "canonical_signals",
        posting_id: postingId,
        canonical_job_id: canonicalJobId,
        existing_source: posting ? asString(posting.source) : null,
        existing_url: posting ? asString(posting.url) : null,
        existing_description_hash: posting
          ? asString(posting.description_hash)
          : null,
        previously_applied: previouslyAppliedFor(index, postingId, canonicalJobId),
        // Evaluations only for deterministic posting matches.
        prior_evaluation: null,
      };
    }

    return {
      client_candidate_id: candidate.client_candidate_id,
      identity_status: "UNSEEN",
      matched_by: "none",
      posting_id: null,
      canonical_job_id: null,
      existing_source: null,
      existing_url: null,
      existing_description_hash: null,
      previously_applied: false,
      prior_evaluation: null,
    };
  });
}

export function emptyPreflightIndex(): DiscoveryPreflightIndex {
  return {
    postingsByNormalizedUrl: new Map(),
    postingsBySourceExternal: new Map(),
    canonicalsByCompanyTitle: new Map(),
    postingsByCanonicalId: new Map(),
    postingsByCompanyHash: new Map(),
    applicationsByPostingId: new Map(),
    applicationsByCanonicalId: new Map(),
    evaluationsByPostingId: new Map(),
  };
}
