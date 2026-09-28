import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHATGPT_FORBIDDEN_SCOPES, TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/012_discovery_profile_generations_and_company_candidates.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("012_discovery_profile_generations_and_company_candidates.sql contract", () => {
  it("is transactional and strictly additive", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(migrationSql).not.toMatch(/DELETE\s+FROM/i);
    expect(migrationSql).not.toMatch(/TRUNCATE/i);
    expect(migrationSql).not.toMatch(/^\s*UPDATE\s/im);
    expect(migrationSql).not.toMatch(/ALTER\s+COLUMN/i);
  });

  it("adds nullable profile identity to GPT evidence without backfill", () => {
    expect(migrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS profile_id TEXT;",
    );
    expect(migrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS profile_version TEXT;",
    );
    expect(migrationSql).not.toMatch(/profile_id TEXT NOT NULL/);
    expect(migrationSql).toContain("idx_discovery_gpt_evaluations_profile_generation");
  });

  it("creates the company candidate registry with duplicate protection", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_company_candidates");
    expect(migrationSql).toContain("discovery_company_candidates_company_key_unique");
    expect(migrationSql).toContain("uq_discovery_company_candidates_provider_org");
    expect(migrationSql).toContain("'pending', 'verifying', 'verified', 'failed', 'rejected'");
    // Registry unique index is guarded so pre-existing duplicates cannot abort the migration.
    expect(migrationSql).toMatch(/IF NOT EXISTS \([\s\S]*HAVING COUNT\(\*\) > 1[\s\S]*uq_discovery_companies_provider_org/);
  });

  it("uses IF NOT EXISTS for every created object", () => {
    const creates = migrationSql.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^\n]*/g) || [];
    expect(creates.length).toBeGreaterThan(0);
    for (const line of creates) {
      expect(line).toContain("IF NOT EXISTS");
    }
  });
});

describe("company expansion + evaluation state MCP permissions", () => {
  it("keeps reads on jobs:read and mutations on jobs:worker", () => {
    expect(TOOL_PERMISSIONS.lookup_discovery_evaluation_states).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.list_discovery_company_candidates).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.list_discovery_posting_url_hints).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.upsert_discovery_company_candidates).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.claim_discovery_company_candidates).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.record_discovery_company_verification).toBe("jobs:worker");
    expect(CHATGPT_FORBIDDEN_SCOPES).toContain("jobs:worker");
  });
});
