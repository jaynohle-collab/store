/**
 * Dashboard Overview summary against the real migrated schema (PGlite).
 * Regression: the summary CTE once referenced pa.application_id /
 * pa.application_status without selecting them, breaking the Overview page.
 */

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

const { getDashboardSummary } = await import("@/lib/db/dashboard");

async function seedPosting(
  sql: PgliteSql,
  opts: { title: string; recommendation: string; score: number; appStatus?: string },
): Promise<string> {
  const canonical = await sql`
    INSERT INTO canonical_jobs (company, company_key, title, normalized_title)
    VALUES ('Acme', 'acme', ${opts.title}, ${opts.title.toLowerCase()})
    RETURNING id
  `;
  const canonicalId = String(canonical[0].id);
  const posting = await sql`
    INSERT INTO job_postings (canonical_job_id, source, external_job_id, url)
    VALUES (${canonicalId}, 'greenhouse', ${opts.title}, ${`https://example.com/${opts.title}`})
    RETURNING id
  `;
  const postingId = String(posting[0].id);
  await sql`
    INSERT INTO job_evaluations (
      posting_id, match_score, recommendation, reason,
      scoring_version, profile_version
    ) VALUES (
      ${postingId}, ${opts.score}, ${opts.recommendation}, 'fit',
      'profile-v1', 'jay-ai-v1'
    )
  `;
  if (opts.appStatus) {
    await sql`
      INSERT INTO applications (canonical_job_id, posting_id, status, applied_at)
      VALUES (${canonicalId}, ${postingId}, ${opts.appStatus}, NOW())
    `;
  }
  return postingId;
}

describe("getDashboardSummary (migrated schema)", () => {
  beforeEach(async () => {
    dbState.sql = await createPgliteFromMigrations();
  });

  it("returns counts without referencing missing CTE columns", async () => {
    const sql = dbState.sql!;
    await seedPosting(sql, { title: "a", recommendation: "save", score: 90 });
    await seedPosting(sql, {
      title: "b",
      recommendation: "save",
      score: 80,
      appStatus: "planned",
    });
    await seedPosting(sql, {
      title: "c",
      recommendation: "save",
      score: 85,
      appStatus: "applied",
    });
    await seedPosting(sql, { title: "d", recommendation: "skip", score: 10 });

    const summary = await getDashboardSummary(70);

    // Unapplied + planned save recommendations count as to-apply; applied does not.
    expect(summary.to_apply).toBe(2);
    expect(summary.applied).toBe(1);
    expect(summary.discovered_today).toBe(4);
    expect(summary.high_match_today).toBe(3);
    expect(summary.profile_version).toBe("jay-ai-v1");
  });

  it("works on an empty database", async () => {
    const summary = await getDashboardSummary(70);
    expect(summary.to_apply).toBe(0);
    expect(summary.applied).toBe(0);
  });
});
