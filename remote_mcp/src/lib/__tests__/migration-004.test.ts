import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/004_job_evaluations.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("004_job_evaluations.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS job_evaluations");
  });

  it("indexes posting_id, evaluated_at, match_score, recommendation", () => {
    expect(migrationSql).toContain("idx_job_evaluations_posting_id");
    expect(migrationSql).toContain("idx_job_evaluations_evaluated_at");
    expect(migrationSql).toContain("idx_job_evaluations_match_score");
    expect(migrationSql).toContain("idx_job_evaluations_recommendation");
  });
});

describe("evaluation MCP permissions", () => {
  it("maps evaluation tools to read/write scopes without scoring claims in names", () => {
    expect(TOOL_PERMISSIONS.save_job_evaluation).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.get_latest_job_evaluation).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.list_job_evaluations).toBe("jobs:read");
  });
});
