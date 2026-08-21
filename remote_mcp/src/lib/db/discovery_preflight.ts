/**
 * Batched read-only DB lookups for discovery preflight.
 * Persistence layer only — does not score or mutate rows.
 */

import { getSql } from "./client";
import {
  checkDiscoveryCandidatesSchema,
  companyHashKey,
  companyTitleKey,
  emptyPreflightIndex,
  normalizePreflightCandidate,
  resolveDiscoveryPreflightResults,
  sourceExternalKey,
  type CheckDiscoveryCandidatesInput,
  type DiscoveryPreflightIndex,
  type DiscoveryPreflightResult,
  type PreflightApplicationRow,
  type PreflightCanonicalRow,
  type PreflightEvaluationRow,
  type PreflightPostingRow,
} from "../discovery/preflight";

function mapPosting(row: Record<string, unknown>): PreflightPostingRow {
  return {
    id: String(row.id),
    canonical_job_id: String(row.canonical_job_id),
    source: row.source == null ? null : String(row.source),
    external_job_id: row.external_job_id == null ? null : String(row.external_job_id),
    url: row.url == null ? null : String(row.url),
    normalized_url: row.normalized_url == null ? null : String(row.normalized_url),
    description_hash: row.description_hash == null ? null : String(row.description_hash),
    location: row.location == null ? null : String(row.location),
  };
}

function mapCanonical(row: Record<string, unknown>): PreflightCanonicalRow {
  return {
    id: String(row.id),
    company_key: String(row.company_key ?? ""),
    normalized_title: String(row.normalized_title ?? ""),
    location: row.location == null ? null : String(row.location),
    normalized_location:
      row.normalized_location == null ? null : String(row.normalized_location),
  };
}

function mapApplication(row: Record<string, unknown>): PreflightApplicationRow {
  return {
    posting_id: String(row.posting_id),
    canonical_job_id: String(row.canonical_job_id),
    status: row.status == null ? null : String(row.status),
  };
}

function mapEvaluation(row: Record<string, unknown>): PreflightEvaluationRow {
  return {
    posting_id: String(row.posting_id),
    match_score:
      row.match_score == null || row.match_score === ""
        ? null
        : Number(row.match_score),
    recommendation: row.recommendation == null ? null : String(row.recommendation),
    reason: row.reason == null ? null : String(row.reason),
    scoring_version: row.scoring_version == null ? null : String(row.scoring_version),
    profile_version: row.profile_version == null ? null : String(row.profile_version),
  };
}

function pushMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** Load a batched identity index for the given candidates (parameterized SQL). */
export async function loadDiscoveryPreflightIndex(
  input: CheckDiscoveryCandidatesInput,
): Promise<DiscoveryPreflightIndex> {
  const sql = getSql();
  const index = emptyPreflightIndex();
  const normalized = input.candidates.map(normalizePreflightCandidate);

  const urls = [
    ...new Set(
      normalized
        .map((c) => c.normalized_url)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const companyKeys = [
    ...new Set(normalized.map((c) => c.company_key).filter(Boolean)),
  ];
  const externalPairs = [
    ...new Set(
      normalized
        .filter((c) => c.external_job_id_key)
        .map((c) => sourceExternalKey(c.source, c.external_job_id_key!)),
    ),
  ];
  const descriptionHashes = [
    ...new Set(
      normalized
        .map((c) => c.description_hash.trim())
        .filter((value) => value.length > 0),
    ),
  ];

  const postingById = new Map<string, PreflightPostingRow>();

  if (urls.length) {
    const rows = await sql`
      SELECT DISTINCT ON (normalized_url)
        id, canonical_job_id, source, external_job_id, url, normalized_url,
        description_hash, location
      FROM job_postings
      WHERE normalized_url = ANY(${urls})
      ORDER BY normalized_url, last_seen_at DESC NULLS LAST, created_at DESC
    `;
    for (const raw of rows) {
      const posting = mapPosting(raw as Record<string, unknown>);
      if (posting.normalized_url) {
        index.postingsByNormalizedUrl.set(posting.normalized_url, posting);
      }
      postingById.set(posting.id, posting);
    }
  }

  if (externalPairs.length) {
    const sources = [
      ...new Set(
        normalized
          .filter((c) => c.external_job_id_key)
          .map((c) => c.source),
      ),
    ];
    const externalIds = [
      ...new Set(
        normalized
          .map((c) => c.external_job_id_key)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const rows = await sql`
      SELECT DISTINCT ON (source, external_job_id)
        id, canonical_job_id, source, external_job_id, url, normalized_url,
        description_hash, location
      FROM job_postings
      WHERE source = ANY(${sources})
        AND external_job_id = ANY(${externalIds})
      ORDER BY source, external_job_id, last_seen_at DESC NULLS LAST, created_at DESC
    `;
    const wanted = new Set(externalPairs);
    for (const raw of rows) {
      const posting = mapPosting(raw as Record<string, unknown>);
      if (!posting.source || !posting.external_job_id) continue;
      const key = sourceExternalKey(posting.source, posting.external_job_id);
      if (!wanted.has(key)) continue;
      index.postingsBySourceExternal.set(key, posting);
      postingById.set(posting.id, posting);
    }
  }

  const canonicalById = new Map<string, PreflightCanonicalRow>();
  if (companyKeys.length) {
    const canonicalRows = await sql`
      SELECT id, company_key, normalized_title, location, normalized_location
      FROM canonical_jobs
      WHERE company_key = ANY(${companyKeys})
      ORDER BY last_seen_at DESC NULLS LAST
    `;
    for (const raw of canonicalRows) {
      const canonical = mapCanonical(raw as Record<string, unknown>);
      canonicalById.set(canonical.id, canonical);
      const key = companyTitleKey(canonical.company_key, canonical.normalized_title);
      pushMapList(index.canonicalsByCompanyTitle, key, canonical);
    }

    const canonicalIds = [...canonicalById.keys()];
    if (canonicalIds.length) {
      const postingRows = await sql`
        SELECT
          id, canonical_job_id, source, external_job_id, url, normalized_url,
          description_hash, location
        FROM job_postings
        WHERE canonical_job_id = ANY(${canonicalIds}::uuid[])
        ORDER BY COALESCE(posted_date, first_seen_at) DESC NULLS LAST
      `;
      for (const raw of postingRows) {
        const posting = mapPosting(raw as Record<string, unknown>);
        postingById.set(posting.id, posting);
        pushMapList(index.postingsByCanonicalId, posting.canonical_job_id, posting);
        const companyKey = canonicalById.get(posting.canonical_job_id)?.company_key;
        if (companyKey && posting.description_hash) {
          pushMapList(
            index.postingsByCompanyHash,
            companyHashKey(companyKey, posting.description_hash),
            posting,
          );
        }
      }
    }
  }

  // Hash-only soft matches may need postings outside the company_key title set
  // when hashes were provided but company canonicals already loaded above cover
  // company_key. Extra bounded lookup by hash for companies already in scope.
  if (companyKeys.length && descriptionHashes.length) {
    const hashRows = await sql`
      SELECT
        p.id, p.canonical_job_id, p.source, p.external_job_id, p.url, p.normalized_url,
        p.description_hash, p.location, c.company_key
      FROM job_postings p
      JOIN canonical_jobs c ON c.id = p.canonical_job_id
      WHERE c.company_key = ANY(${companyKeys})
        AND p.description_hash = ANY(${descriptionHashes})
    `;
    for (const raw of hashRows) {
      const row = raw as Record<string, unknown>;
      const posting = mapPosting(row);
      postingById.set(posting.id, posting);
      const companyKey = String(row.company_key ?? "");
      if (companyKey && posting.description_hash) {
        const key = companyHashKey(companyKey, posting.description_hash);
        const existing = index.postingsByCompanyHash.get(key) || [];
        if (!existing.some((p) => p.id === posting.id)) {
          pushMapList(index.postingsByCompanyHash, key, posting);
        }
      }
      if (!index.postingsByCanonicalId.has(posting.canonical_job_id)) {
        pushMapList(index.postingsByCanonicalId, posting.canonical_job_id, posting);
      } else {
        const list = index.postingsByCanonicalId.get(posting.canonical_job_id)!;
        if (!list.some((p) => p.id === posting.id)) list.push(posting);
      }
    }
  }

  const postingIds = [...postingById.keys()];
  const canonicalIdsForApps = [
    ...new Set([
      ...[...postingById.values()].map((p) => p.canonical_job_id),
      ...canonicalById.keys(),
    ]),
  ];

  if (postingIds.length || canonicalIdsForApps.length) {
    let appRows: Record<string, unknown>[] = [];
    if (postingIds.length && canonicalIdsForApps.length) {
      appRows = (await sql`
        SELECT posting_id, canonical_job_id, status
        FROM applications
        WHERE posting_id = ANY(${postingIds}::uuid[])
           OR canonical_job_id = ANY(${canonicalIdsForApps}::uuid[])
      `) as Record<string, unknown>[];
    } else if (postingIds.length) {
      appRows = (await sql`
        SELECT posting_id, canonical_job_id, status
        FROM applications
        WHERE posting_id = ANY(${postingIds}::uuid[])
      `) as Record<string, unknown>[];
    } else {
      appRows = (await sql`
        SELECT posting_id, canonical_job_id, status
        FROM applications
        WHERE canonical_job_id = ANY(${canonicalIdsForApps}::uuid[])
      `) as Record<string, unknown>[];
    }
    for (const raw of appRows) {
      const app = mapApplication(raw);
      pushMapList(index.applicationsByPostingId, app.posting_id, app);
      pushMapList(index.applicationsByCanonicalId, app.canonical_job_id, app);
    }
  }

  if (postingIds.length) {
    const evalRows = await sql`
      SELECT DISTINCT ON (posting_id)
        posting_id, match_score, recommendation, reason,
        scoring_version, profile_version
      FROM job_evaluations
      WHERE posting_id = ANY(${postingIds}::uuid[])
      ORDER BY posting_id, evaluated_at DESC, created_at DESC
    `;
    for (const raw of evalRows) {
      const evaluation = mapEvaluation(raw as Record<string, unknown>);
      index.evaluationsByPostingId.set(evaluation.posting_id, evaluation);
    }
  }

  return index;
}

/** Read-only discovery identity preflight for up to 100 candidates. */
export async function checkDiscoveryCandidates(
  input: CheckDiscoveryCandidatesInput,
): Promise<{ results: DiscoveryPreflightResult[] }> {
  const parsed = checkDiscoveryCandidatesSchema.parse(input);
  const index = await loadDiscoveryPreflightIndex(parsed);
  return {
    results: resolveDiscoveryPreflightResults(parsed.candidates, index),
  };
}

export {
  checkDiscoveryCandidatesSchema,
  discoveryPreflightCandidateSchema,
} from "../discovery/preflight";
