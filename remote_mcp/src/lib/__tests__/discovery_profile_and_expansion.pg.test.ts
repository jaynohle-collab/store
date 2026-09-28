/**
 * Migration 012 behaviour on the real migrated schema (PGlite, never Neon):
 * profile-generation GPT evidence, evaluation state lookup, and company
 * candidate verification / promotion without duplicates.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPgliteFromMigrations, type PgliteSql } from "./helpers/pglite_sql";

const { dbState } = vi.hoisted(() => ({
  dbState: { sql: null as PgliteSql | null },
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    if (!dbState.sql) throw new Error("pglite sql not initialized");
    return dbState.sql;
  },
  getTransactionalSql: () => {
    if (!dbState.sql) throw new Error("pglite sql not initialized");
    return dbState.sql;
  },
  resetSqlClient: () => undefined,
}));

const { lookupDiscoveryEvaluationStates, recordDiscoveryEvaluations } = await import(
  "@/lib/db/discovery_gpt_evaluations"
);
const { checkDiscoveryCandidates } = await import("@/lib/db/discovery_preflight");
const {
  claimDiscoveryCompanyCandidates,
  getCompanyExpansionSummary,
  listDiscoveryPostingUrlHints,
  recordDiscoveryCompanyVerification,
  upsertDiscoveryCompanyCandidates,
} = await import("@/lib/db/discovery_company_candidates");

const WORKER = "github-actions";
const PROFILE = { profile_id: "jay", profile_version: "jay-ai-v1" };

function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    client_evaluation_id: "11111111-1111-4111-8111-111111111111",
    client_candidate_id: "greenhouse:acme:1",
    company: "Acme",
    title: "Senior AI Engineer",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    source: "greenhouse",
    external_job_id: "1",
    location: "Remote - US",
    description_hash: "0123456789abcdef",
    gpt_relevance_score: 40,
    gpt_decision: "REJECTED_LOW_SCORE" as const,
    reasoning_summary: "weak fit",
    evaluation_version: "gpt-fit-v2",
    remote_scope: "US_NATIONWIDE" as const,
    direct_posting_url_verified: true,
    normalization_version: "fingerprint-v1",
    posting_status: "OPEN" as const,
    posting_status_verified_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const LOOKUP_CANDIDATE = {
  client_candidate_id: "greenhouse:acme:1",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  source: "greenhouse",
  external_job_id: "1",
};

describe("migration 012 on PGlite", () => {
  beforeEach(async () => {
    dbState.sql = await createPgliteFromMigrations();
  });

  it("is idempotent when re-applied", async () => {
    const file = path.resolve(
      __dirname,
      "../../../migrations/012_discovery_profile_generations_and_company_candidates.sql",
    );
    await dbState.sql!.raw.exec(readFileSync(file, "utf8"));
    const cols = await dbState.sql!`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'discovery_gpt_evaluations'
        AND column_name IN ('profile_id', 'profile_version')
    `;
    expect(cols).toHaveLength(2);
  });

  it("stores profile identity and keeps legacy rows readable as the legacy generation", async () => {
    await recordDiscoveryEvaluations({ evaluations: [evaluation()] });
    const legacy = await lookupDiscoveryEvaluationStates({
      evaluation_version: "gpt-fit-v2",
      profile: { ...PROFILE, include_legacy_unversioned: true },
      candidates: [LOOKUP_CANDIDATE],
    });
    expect(legacy.states[0].evaluation?.gpt_decision).toBe("REJECTED_LOW_SCORE");
    expect(legacy.states[0].evaluation?.profile_id).toBeNull();

    const other = await lookupDiscoveryEvaluationStates({
      evaluation_version: "gpt-fit-v2",
      profile: { profile_id: "jay", profile_version: "jay-ai-v2" },
      candidates: [LOOKUP_CANDIDATE],
    });
    expect(other.states[0].evaluation).toBeNull();

    await recordDiscoveryEvaluations({
      evaluations: [
        evaluation({
          client_evaluation_id: "22222222-2222-4222-8222-222222222222",
          profile_id: "jay",
          profile_version: "jay-ai-v2",
          gpt_relevance_score: 80,
          gpt_decision: "QUALIFIED",
        }),
      ],
    });
    const v2 = await lookupDiscoveryEvaluationStates({
      evaluation_version: "gpt-fit-v2",
      profile: { profile_id: "jay", profile_version: "jay-ai-v2" },
      candidates: [LOOKUP_CANDIDATE],
    });
    expect(v2.states[0].evaluation?.gpt_decision).toBe("QUALIFIED");
    expect(v2.states[0].evaluation?.profile_version).toBe("jay-ai-v2");

    // Older generation evidence is never overwritten.
    const rows = await dbState.sql!`SELECT COUNT(*)::int AS n FROM discovery_gpt_evaluations`;
    expect(rows[0].n).toBe(2);
  });

  it("rejects half-specified profile identity", async () => {
    await expect(
      recordDiscoveryEvaluations({
        evaluations: [evaluation({ profile_id: "jay" })],
      }),
    ).rejects.toThrow(/profile_id and profile_version/);
  });

  it("treats a changed profile identity as a conflicting replay of the same id", async () => {
    await recordDiscoveryEvaluations({ evaluations: [evaluation()] });
    await expect(
      recordDiscoveryEvaluations({
        evaluations: [evaluation({ profile_id: "jay", profile_version: "jay-ai-v2" })],
      }),
    ).rejects.toThrow(/different evaluation payload/);
    // Identical replay stays idempotent.
    const replay = await recordDiscoveryEvaluations({ evaluations: [evaluation()] });
    expect(replay.evaluations).toHaveLength(1);
  });

  it.each([
    ["pending", true],
    ["reverted", true],
    ["failed", false],
  ])("treats evidence in a %s inbox batch as attached=%s", async (status, attached) => {
    const saved = await recordDiscoveryEvaluations({
      evaluations: [
        evaluation({ gpt_relevance_score: 85, gpt_decision: "QUALIFIED" }),
      ],
    });
    const evaluationId = String(saved.evaluations[0].evaluation_id);
    const payload = JSON.stringify({
      jobs: [{ url: LOOKUP_CANDIDATE.url, gpt_evaluation: { evaluation_id: evaluationId } }],
    });
    await dbState.sql!`
      INSERT INTO discovery_inbox_batches (source, status, payload, job_count)
      VALUES ('automatic-discovery', ${status}, ${payload}::jsonb, 1)
    `;
    const result = await lookupDiscoveryEvaluationStates({
      evaluation_version: "gpt-fit-v2",
      profile: { ...PROFILE, include_legacy_unversioned: true },
      candidates: [LOOKUP_CANDIDATE],
    });
    expect(result.states[0].submitted_to_inbox).toBe(attached);
  });

  it("reports evidence already attached to an inbox batch", async () => {
    const saved = await recordDiscoveryEvaluations({
      evaluations: [
        evaluation({ gpt_relevance_score: 85, gpt_decision: "QUALIFIED" }),
      ],
    });
    const evaluationId = String(saved.evaluations[0].evaluation_id);
    const payload = JSON.stringify({
      jobs: [{ url: LOOKUP_CANDIDATE.url, gpt_evaluation: { evaluation_id: evaluationId } }],
    });
    await dbState.sql!`
      INSERT INTO discovery_inbox_batches (source, status, payload, job_count)
      VALUES ('automatic-discovery', 'pending', ${payload}::jsonb, 1)
    `;
    const result = await lookupDiscoveryEvaluationStates({
      evaluation_version: "gpt-fit-v2",
      profile: { ...PROFILE, include_legacy_unversioned: true },
      candidates: [LOOKUP_CANDIDATE],
    });
    expect(result.states[0].submitted_to_inbox).toBe(true);
  });

  it("filters preflight prior GPT evidence by profile generation when requested", async () => {
    await recordDiscoveryEvaluations({ evaluations: [evaluation()] });
    const canonical = await dbState.sql!`
      INSERT INTO canonical_jobs (company, company_key, title, normalized_title)
      VALUES ('Acme', 'acme', 'Senior AI Engineer', 'senior ai engineer') RETURNING id
    `;
    await dbState.sql!`
      INSERT INTO job_postings (canonical_job_id, source, external_job_id, url, normalized_url, description_hash)
      VALUES (${canonical[0].id}, 'greenhouse', '1', ${LOOKUP_CANDIDATE.url},
              'https://boards.greenhouse.io/acme/jobs/1', '0123456789abcdef')
    `;
    const candidate = {
      client_candidate_id: "c1",
      company: "Acme",
      title: "Senior AI Engineer",
      url: LOOKUP_CANDIDATE.url,
      source: "greenhouse",
      external_job_id: "1",
      location: "Remote - US",
      posted_date: "",
      description_hash: "0123456789abcdef",
    };
    const unfiltered = await checkDiscoveryCandidates({
      evaluation_version: "gpt-fit-v2",
      candidates: [candidate],
    });
    expect(unfiltered.results[0].gpt_skip_allowed).toBe(true);

    const otherGeneration = await checkDiscoveryCandidates({
      evaluation_version: "gpt-fit-v2",
      profile: {
        profile_id: "jay",
        profile_version: "jay-ai-v2",
        include_legacy_unversioned: false,
      },
      candidates: [candidate],
    });
    expect(otherGeneration.results[0].gpt_skip_allowed).toBe(false);
    expect(otherGeneration.results[0].prior_gpt_evaluation).toBeNull();
  });
});

describe("company candidate expansion", () => {
  beforeEach(async () => {
    // Migration 010 seeds ten disabled starter companies (including stripe).
    dbState.sql = await createPgliteFromMigrations();
  });

  const seed = (key: string, org: string, provider = "greenhouse") => ({
    company_key: key,
    company_name: key,
    ats_provider: provider as "greenhouse",
    ats_org_id: org,
    discovery_source: "seed_catalog" as const,
  });

  it("is idempotent and never duplicates registry companies or ATS orgs", async () => {
    const first = await upsertDiscoveryCompanyCandidates({
      candidates: [seed("anthropic", "anthropic"), seed("stripe", "stripe")],
    });
    expect(first.results.map((r) => r.outcome)).toEqual(["inserted", "already_registered"]);

    const again = await upsertDiscoveryCompanyCandidates({
      candidates: [
        seed("anthropic", "anthropic"),
        seed("anthropic-dup", "Anthropic"),
        seed("stripe-alias", "STRIPE"),
      ],
    });
    expect(again.results.map((r) => r.outcome)).toEqual([
      "exists",
      "duplicate_org",
      "already_registered",
    ]);
    const count = await dbState.sql!`SELECT COUNT(*)::int AS n FROM discovery_company_candidates`;
    expect(count[0].n).toBe(1);
  });

  it("promotes verified candidates once, enabled at normal priority", async () => {
    await upsertDiscoveryCompanyCandidates({
      candidates: [{ ...seed("anthropic", "anthropic"), suggested_priority: "high" }],
    });
    const claimed = await claimDiscoveryCompanyCandidates({ worker_identity: WORKER });
    expect(claimed.claimed_count).toBe(1);
    // A second worker cannot claim the leased candidate.
    const second = await claimDiscoveryCompanyCandidates({ worker_identity: "other" });
    expect(second.claimed_count).toBe(0);

    const id = String(claimed.candidates[0].id);
    const result = await recordDiscoveryCompanyVerification({
      candidate_id: id,
      worker_identity: WORKER,
      outcome: "verified",
      verified_job_count: 42,
    });
    expect(result.promoted).toBe(true);
    const company = await dbState.sql!`
      SELECT enabled, scan_priority, ats_org_id FROM discovery_companies WHERE company_key = 'anthropic'
    `;
    expect(company[0]).toMatchObject({ enabled: true, scan_priority: "normal", ats_org_id: "anthropic" });

    const replay = await recordDiscoveryCompanyVerification({
      candidate_id: id,
      worker_identity: WORKER,
      outcome: "verified",
    });
    expect(replay.idempotent_replay).toBe(true);
    const n = await dbState.sql!`
      SELECT COUNT(*)::int AS n FROM discovery_companies WHERE company_key = 'anthropic'
    `;
    expect(n[0].n).toBe(1);
    expect((await getCompanyExpansionSummary()).verified).toBe(1);
  });

  it("links instead of duplicating when the org was registered after candidacy", async () => {
    await upsertDiscoveryCompanyCandidates({ candidates: [seed("mistral", "mistral", "ashby")] });
    await dbState.sql!`
      INSERT INTO discovery_companies (company_key, company_name, ats_provider, ats_org_id, enabled)
      VALUES ('mistral-ai', 'Mistral', 'ashby', 'Mistral', FALSE)
    `;
    const claimed = await claimDiscoveryCompanyCandidates({ worker_identity: WORKER });
    const result = await recordDiscoveryCompanyVerification({
      candidate_id: String(claimed.candidates[0].id),
      worker_identity: WORKER,
      outcome: "verified",
    });
    expect(result.promoted).toBe(false);
    expect(result.candidate.promoted_company_id).toBeTruthy();
    const existing = await dbState.sql!`
      SELECT enabled FROM discovery_companies WHERE company_key = 'mistral-ai'
    `;
    expect(existing[0].enabled).toBe(false);
  });

  it("backs off failures and rejects after repeated failures", async () => {
    await upsertDiscoveryCompanyCandidates({ candidates: [seed("ghost", "ghost")] });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await dbState.sql!`
        UPDATE discovery_company_candidates SET next_verification_at = NOW() - interval '1 minute'
      `;
      const claimed = await claimDiscoveryCompanyCandidates({ worker_identity: WORKER });
      expect(claimed.claimed_count).toBe(1);
      const result = await recordDiscoveryCompanyVerification({
        candidate_id: String(claimed.candidates[0].id),
        worker_identity: WORKER,
        outcome: "failed",
        error_category: "server_error",
        error_summary: "HTTP 503 Bearer abc.def.ghi",
      });
      expect(result.candidate.verification_status).toBe(attempt < 5 ? "failed" : "rejected");
      expect(String(result.candidate.last_error_summary)).not.toContain("abc.def.ghi");
    }
    await dbState.sql!`
      UPDATE discovery_company_candidates SET next_verification_at = NOW() - interval '1 minute'
    `;
    expect((await claimDiscoveryCompanyCandidates({ worker_identity: WORKER })).claimed_count).toBe(0);
  });

  it("recovers stale verification leases", async () => {
    await upsertDiscoveryCompanyCandidates({ candidates: [seed("stale", "stale")] });
    await claimDiscoveryCompanyCandidates({ worker_identity: "crashed" });
    await dbState.sql!`
      UPDATE discovery_company_candidates SET lease_expires_at = NOW() - interval '1 minute'
    `;
    const reclaimed = await claimDiscoveryCompanyCandidates({ worker_identity: WORKER });
    expect(reclaimed.claimed_count).toBe(1);
    await expect(
      recordDiscoveryCompanyVerification({
        candidate_id: String(reclaimed.candidates[0].id),
        worker_identity: "crashed",
        outcome: "verified",
      }),
    ).rejects.toThrow(/owner_mismatch/);
  });

  it("lists official ATS posting URL hints from history", async () => {
    const canonical = await dbState.sql!`
      INSERT INTO canonical_jobs (company, company_key, title, normalized_title)
      VALUES ('Acme', 'acme', 'Eng', 'eng') RETURNING id
    `;
    await dbState.sql!`
      INSERT INTO job_postings (canonical_job_id, source, url) VALUES
        (${canonical[0].id}, 'greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/9'),
        (${canonical[0].id}, 'other', 'https://example.com/careers/1')
    `;
    const hints = await listDiscoveryPostingUrlHints({});
    expect(hints.map((h) => h.url)).toEqual(["https://job-boards.greenhouse.io/acme/jobs/9"]);
  });
});
