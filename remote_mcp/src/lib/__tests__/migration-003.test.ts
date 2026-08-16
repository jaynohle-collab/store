import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/003_job_lifecycle.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("003_job_lifecycle.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE\s+jobs/i);
    expect(migrationSql).toMatch(/legacy `jobs` table is intentionally preserved/);
  });

  it("creates lifecycle tables", () => {
    for (const table of [
      "canonical_jobs",
      "job_postings",
      "applications",
      "application_events",
      "discovery_runs",
    ]) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("enforces posting/canonical integrity for applications", () => {
    expect(migrationSql).toContain("uq_job_postings_id_canonical_job_id");
    expect(migrationSql).toContain("fk_applications_posting_canonical");
    expect(migrationSql).toMatch(
      /FOREIGN KEY \(posting_id, canonical_job_id\)\s+REFERENCES job_postings \(id, canonical_job_id\)/,
    );
  });

  it("enforces one application per posting_id", () => {
    expect(migrationSql).toContain("uq_applications_posting_id");
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_posting_id\s+ON applications \(posting_id\)/,
    );
  });

  it("does not require globally unique URLs", () => {
    expect(migrationSql).toMatch(/URL is intentionally NOT globally unique/i);
    expect(migrationSql).toContain("uq_job_postings_source_external_id");
  });

  it("keeps posted_date separate from first_seen/last_seen", () => {
    expect(migrationSql).toContain("posted_date TIMESTAMPTZ");
    expect(migrationSql).toContain("first_seen_at TIMESTAMPTZ");
    expect(migrationSql).toContain("last_seen_at TIMESTAMPTZ");
  });
});
