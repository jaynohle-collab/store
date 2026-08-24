import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/006_discovery_source_rotation.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("006_discovery_source_rotation.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_sources");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_source_runs");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_rotation_state");
  });

  it("seeds the five initial sources in order", () => {
    expect(migrationSql).toContain("'ashby'");
    expect(migrationSql).toContain("'greenhouse'");
    expect(migrationSql).toContain("'lever'");
    expect(migrationSql).toContain("'workday'");
    expect(migrationSql).toContain("'company_careers'");
    expect(migrationSql).toContain("source_failure_counts");
    expect(migrationSql).toContain("attempt_number");
    expect(migrationSql).toContain("skipped_after_failures");
  });

  it("enforces singleton claim and counter chain at database level", () => {
    expect(migrationSql).toContain("idx_discovery_source_runs_one_claimed");
    expect(migrationSql).toContain("discovery_source_runs_counts_chain");
    expect(migrationSql).toContain("preflight_skipped_count <= discovered_count");
    expect(migrationSql).toContain("submitted_count <= qualified_count");
  });

  it("does not alter inbox or lifecycle tables", () => {
    expect(migrationSql).not.toMatch(/ALTER TABLE discovery_inbox/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE canonical_jobs/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE job_postings/i);
  });
});

describe("discovery rotation MCP permissions", () => {
  it("maps get to read and claim/complete/fail to write", () => {
    expect(TOOL_PERMISSIONS.get_discovery_rotation).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.claim_next_discovery_source).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.complete_discovery_source).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.fail_discovery_source).toBe("jobs:write");
  });
});
