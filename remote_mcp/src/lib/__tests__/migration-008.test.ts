import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/008_discovery_gpt_v2_quality_gates.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("008_discovery_gpt_v2_quality_gates.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS remote_scope");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS direct_posting_url_verified");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS normalization_version");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS posting_status");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS posting_status_verified_at");
    expect(migrationSql).toContain("discovery_gpt_evaluations_gpt_fit_v2_qualified_check");
  });

  it("allows nullable v2 fields for gpt-fit-v1 history", () => {
    expect(migrationSql).toContain("remote_scope IS NULL");
    expect(migrationSql).toContain("US_NATIONWIDE");
    expect(migrationSql).toContain("US_RESTRICTED");
  });
});

describe("discovery quality gate MCP permissions", () => {
  it("maps compute hashes to read and record to write", () => {
    expect(TOOL_PERMISSIONS.compute_discovery_description_hashes).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.record_discovery_evaluations).toBe("jobs:write");
  });
});
