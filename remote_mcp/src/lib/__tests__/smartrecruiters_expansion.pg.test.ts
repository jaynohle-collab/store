import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteFromMigrations, type PgliteSql } from "./helpers/pglite_sql";

const { dbState } = vi.hoisted(() => ({ dbState: { sql: null as PgliteSql | null } }));
vi.mock("@/lib/db/client", () => ({
  getSql: () => dbState.sql,
  getTransactionalSql: () => dbState.sql,
}));
const {
  companyCandidateInputSchema, upsertDiscoveryCompanyCandidates,
  claimDiscoveryCompanyCandidates, recordDiscoveryCompanyVerification, listDiscoveryPostingUrlHints,
} = await import("@/lib/db/discovery_company_candidates");
const migration = readFileSync(path.resolve(__dirname,
  "../../../migrations/016_smartrecruiters_company_candidates.sql"), "utf8");
const candidate = {
  company_key: "example-smart", company_name: "Example Smart", ats_provider: "smartrecruiters" as const,
  ats_org_id: "ExampleSmart", discovery_source: "seed_catalog" as const,
};

describe("SmartRecruiters candidate schema", () => {
  it("accepts the provider while requiring an org identifier", () => {
    expect(companyCandidateInputSchema.parse(candidate).ats_provider).toBe("smartrecruiters");
    expect(companyCandidateInputSchema.safeParse({ ...candidate, ats_org_id: undefined }).success).toBe(false);
    expect(companyCandidateInputSchema.safeParse({ ...candidate, ats_provider: "unknown" }).success).toBe(false);
  });
  it("limits migration 016 to a transactional provider-constraint expansion", () => {
    expect(migration).toMatch(/^BEGIN;/m);
    expect(migration).toMatch(/^COMMIT;/m);
    expect(migration).not.toMatch(/UPDATE|DELETE|TRUNCATE|INSERT|DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS discovery_company_candidates_provider_check");
  });
});

describe("SmartRecruiters expansion on the migrated schema", () => {
  beforeEach(async () => { dbState.sql = await createPgliteFromMigrations(); });
  afterEach(async () => { await dbState.sql?.raw.close(); });

  it("reapplies migration without altering candidate or company state", async () => {
    await upsertDiscoveryCompanyCandidates({ candidates: [candidate] });
    const before = await dbState.sql!`SELECT * FROM discovery_company_candidates`;
    const companies = await dbState.sql!`SELECT * FROM discovery_companies ORDER BY id`;
    await dbState.sql!.raw.exec(migration);
    await dbState.sql!.raw.exec(migration);
    expect(await dbState.sql!`SELECT * FROM discovery_company_candidates`).toEqual(before);
    expect(await dbState.sql!`SELECT * FROM discovery_companies ORDER BY id`).toEqual(companies);
    await expect(dbState.sql!`
      INSERT INTO discovery_company_candidates
        (company_key, company_name, ats_provider, ats_org_id, discovery_source)
      VALUES ('invalid', 'Invalid', 'invalid', 'invalid', 'seed_catalog')
    `).rejects.toThrow(/provider_check/);
  });

  it("promotes a verified candidate once at normal priority and deduplicates orgs", async () => {
    await upsertDiscoveryCompanyCandidates({ candidates: [{ ...candidate, suggested_priority: "high" }] });
    expect((await upsertDiscoveryCompanyCandidates({ candidates: [
      { ...candidate, company_key: "alias", ats_org_id: "examplesmart" },
    ] })).results[0].outcome).toBe("duplicate_org");
    const claim = await claimDiscoveryCompanyCandidates({ worker_identity: "test" });
    const verification = {
      candidate_id: String(claim.candidates[0].id), worker_identity: "test",
      outcome: "verified" as const, verified_job_count: 200,
    };
    expect((await recordDiscoveryCompanyVerification(verification)).promoted).toBe(true);
    expect((await recordDiscoveryCompanyVerification(verification)).idempotent_replay).toBe(true);
    const rows = await dbState.sql!`
      SELECT ats_provider, ats_org_id, enabled, scan_priority
      FROM discovery_companies WHERE company_key = 'example-smart'
    `;
    expect(rows).toEqual([{
      ats_provider: "smartrecruiters", ats_org_id: "ExampleSmart", enabled: true, scan_priority: "normal",
    }]);
  });

  it("returns only official numeric posting URL hints", async () => {
    const canonical = await dbState.sql!`
      INSERT INTO canonical_jobs (company, company_key, title, normalized_title)
      VALUES ('Example', 'example', 'Engineer', 'engineer') RETURNING id
    `;
    const good = [
      "https://www.smartrecruiters.com/Example/1234-engineer",
      "https://jobs.smartrecruiters.com/Example/5678",
    ];
    const bad = [
      "https://careers.smartrecruiters.com/Example",
      "https://api.smartrecruiters.com/v1/companies/Example/postings/1234",
      "https://www.smartrecruiters.com.evil.test/Example/1234",
      "https://fakejobs.smartrecruiters.com/Example/1234",
      "https://jobs.smartrecruiters.com@evil.test/Example/1234",
      "https://jobs.smartrecruiters.com/Example",
      "https://www.smartrecruiters.com/Example/not-a-number",
      "https://www.smartrecruiters.com/Example/1234/other",
    ];
    for (const url of [...good, ...bad]) {
      await dbState.sql!`INSERT INTO job_postings (canonical_job_id, source, url)
        VALUES (${canonical[0].id}, 'smartrecruiters', ${url})`;
    }
    expect((await listDiscoveryPostingUrlHints()).map((r) => r.url).sort()).toEqual(good.sort());
  });
});
