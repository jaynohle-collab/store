import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/011_discovery_pending_evaluations.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("011_discovery_pending_evaluations.sql contract", () => {
  it("creates durable pending queue with fingerprint uniqueness", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_pending_evaluations");
    expect(migrationSql).toContain("discovery_pending_evaluations_fingerprint_unique");
    expect(migrationSql).toContain("'pending'");
    expect(migrationSql).toContain("'in_progress'");
    expect(migrationSql).toContain("'completed'");
    expect(migrationSql).toContain("'abandoned'");
    expect(migrationSql).toContain("description_hash");
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).not.toMatch(/DELETE FROM/i);
  });
});

describe("pending evaluation MCP permissions", () => {
  it("scopes preserve/claim/complete to jobs:worker", () => {
    expect(TOOL_PERMISSIONS.preserve_pending_discovery_evaluations).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.claim_pending_discovery_evaluations).toBe("jobs:worker");
    expect(TOOL_PERMISSIONS.complete_pending_discovery_evaluation).toBe("jobs:worker");
  });
});
