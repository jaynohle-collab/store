import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/007_discovery_gpt_evaluations.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("007_discovery_gpt_evaluations.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE job_evaluations/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE canonical_jobs/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE discovery_inbox/i);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_gpt_evaluations");
  });

  it("enforces decision, score, reasoning, and client_evaluation_id uniqueness", () => {
    expect(migrationSql).toContain("QUALIFIED");
    expect(migrationSql).toContain("REJECTED_LOW_SCORE");
    expect(migrationSql).toContain("REJECTED_HARD_RULE");
    expect(migrationSql).toContain("gpt_relevance_score >= 0 AND gpt_relevance_score <= 100");
    expect(migrationSql).toContain("char_length(reasoning_summary) <= 1000");
    expect(migrationSql).toContain("client_evaluation_id UUID NOT NULL");
    expect(migrationSql).toContain("UNIQUE (client_evaluation_id)");
  });

  it("indexes identity lookups by server created_at and id", () => {
    expect(migrationSql).toContain("idx_discovery_gpt_evaluations_normalized_url");
    expect(migrationSql).toContain("idx_discovery_gpt_evaluations_source_external");
    expect(migrationSql).toContain("idx_discovery_gpt_evaluations_created_at");
    expect(migrationSql).toContain("idx_discovery_gpt_evaluations_evaluation_version");
    expect(migrationSql).toContain("created_at DESC, id DESC");
    expect(migrationSql).toContain("evaluation_version");
    // Client evaluated_at must not drive latest ordering indexes alone.
    expect(migrationSql).toMatch(/evaluated_at TIMESTAMPTZ,/);
  });
});

describe("GPT evaluation MCP permissions", () => {
  it("maps record_discovery_evaluations to jobs:write", () => {
    expect(TOOL_PERMISSIONS.record_discovery_evaluations).toBe("jobs:write");
  });
});
