import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOL_PERMISSIONS } from "@/lib/config";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/005_discovery_inbox.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("005_discovery_inbox.sql contract", () => {
  it("is additive and transactional", () => {
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);
    expect(migrationSql).not.toMatch(/DROP TABLE/i);
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS discovery_inbox_batches");
  });

  it("does not replace discovery_runs", () => {
    expect(migrationSql).not.toMatch(/DROP TABLE.*discovery_runs/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE discovery_runs/i);
  });

  it("defines inbox statuses and pending index", () => {
    expect(migrationSql).toContain("pending");
    expect(migrationSql).toContain("processing");
    expect(migrationSql).toContain("completed");
    expect(migrationSql).toContain("failed");
    expect(migrationSql).toContain("idx_discovery_inbox_batches_status");
    expect(migrationSql).toContain("idx_discovery_inbox_batches_pending_submitted");
  });
});

describe("discovery inbox MCP permissions", () => {
  it("maps submit/claim/complete/fail to write and get/list to read", () => {
    expect(TOOL_PERMISSIONS.submit_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.claim_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.complete_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.fail_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.get_discovery_batch).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.list_pending_discovery_batches).toBe("jobs:read");
  });
});
