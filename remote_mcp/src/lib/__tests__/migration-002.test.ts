import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isValidUuidString,
  mayReplaceExistingNonNullIds,
  planIdConversion,
  planJsonbConversion,
  planTimestamptzConversion,
  requiresExplicitTransaction,
} from "@/lib/db/migrationCompatibility";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/002_neon_poc_compatibility.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("002_neon_poc_compatibility.sql contract", () => {
  it("wraps the entire migration in an explicit BEGIN/COMMIT transaction", () => {
    expect(requiresExplicitTransaction()).toBe(true);
    expect(migrationSql).toMatch(/^BEGIN;/m);
    expect(migrationSql).toMatch(/^COMMIT;/m);

    const beginIndex = migrationSql.indexOf("BEGIN;");
    const commitIndex = migrationSql.lastIndexOf("COMMIT;");
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);

    // Body that can mutate schema/data sits inside the transaction.
    const body = migrationSql.slice(beginIndex, commitIndex);
    expect(body).toContain("ALTER TABLE jobs");
    expect(body).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_storage_id");
  });

  it("detects existing id type and converts TEXT only via USING id::uuid", () => {
    expect(migrationSql).toMatch(/id_udt\s*=\s*'uuid'/);
    expect(migrationSql).toMatch(/id_udt IN \('text', 'varchar', 'bpchar'\)/);
    expect(migrationSql).toMatch(/ALTER TABLE jobs ALTER COLUMN id TYPE UUID USING btrim\(id::text\)::uuid/);
    expect(migrationSql).toMatch(/Existing data was NOT modified/);
  });

  it("aborts when any non-null TEXT id is not a valid UUID string", () => {
    expect(migrationSql).toMatch(/are not valid UUID strings/);
    expect(migrationSql).toMatch(/Fix invalid IDs manually, then re-run this migration/);
    expect(migrationSql).not.toMatch(
      /UPDATE jobs SET id = gen_random_uuid\(\) WHERE id IS NOT NULL/i,
    );
  });

  it("makes invalid legacy data abort inside the transaction for full rollback", () => {
    // RAISE EXCEPTION inside BEGIN/COMMIT rolls back earlier DDL/DML in this script.
    const beginIndex = migrationSql.indexOf("BEGIN;");
    const commitIndex = migrationSql.lastIndexOf("COMMIT;");
    const transactionalBody = migrationSql.slice(beginIndex, commitIndex);

    expect(transactionalBody).toContain("RAISE EXCEPTION");
    expect(transactionalBody).toContain("Existing data was NOT modified");
    expect(transactionalBody).toMatch(/are not valid UUID strings/);
    // No escape hatch that commits partial work before validation failures.
    expect(transactionalBody).not.toMatch(/COMMIT;/);
  });

  it("does not silently convert TIMESTAMP WITHOUT TIME ZONE without an explicit timezone", () => {
    expect(migrationSql).toMatch(/explicit timezone assumption is required/);
    expect(migrationSql).toMatch(/TIMESTAMP WITHOUT TIME ZONE/);
    // Must not emit the invalid/implicit conversion path.
    expect(migrationSql).not.toMatch(
      /ALTER TABLE jobs ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE/,
    );
  });

  it("preserves UUID ids and only backfills NULLs", () => {
    expect(migrationSql).toMatch(/UPDATE jobs SET id = gen_random_uuid\(\) WHERE id IS NULL/);
    expect(migrationSql).toMatch(/ALTER TABLE jobs ALTER COLUMN id SET DEFAULT gen_random_uuid\(\)/);
  });

  it("keeps description_hash as TEXT and repairs other expected types", () => {
    expect(migrationSql).toMatch(/description_hash remains TEXT/);
    expect(migrationSql).toMatch(/posted_date.*created_at.*updated_at/s);
    expect(migrationSql).toMatch(/required_skills.*preferred_skills/s);
    expect(migrationSql).toMatch(/TYPE TIMESTAMPTZ/);
    expect(migrationSql).toMatch(/TYPE JSONB/);
  });

  it("does not drop jobs or delete rows", () => {
    expect(migrationSql).not.toMatch(/DROP TABLE\s+jobs/i);
    expect(migrationSql).not.toMatch(/DELETE FROM\s+jobs/i);
    expect(migrationSql).not.toMatch(/TRUNCATE\s+jobs/i);
  });
});

describe("migration compatibility scenarios", () => {
  it("new schema / already-UUID id: noop conversion, preserve values", () => {
    const plan = planIdConversion(
      { udtName: "uuid", dataType: "uuid" },
      ["11111111-1111-4111-8111-111111111111", null],
    );
    expect(plan.action).toBe("noop");
    expect(mayReplaceExistingNonNullIds()).toBe(false);
  });

  it("existing TEXT id with valid UUID strings: convert with USING", () => {
    const values = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const plan = planIdConversion(
      { udtName: "text", dataType: "text" },
      values,
    );
    expect(plan).toEqual({
      action: "convert",
      using: "btrim(id::text)::uuid",
    });
    expect(values.every(isValidUuidString)).toBe(true);
  });

  it("existing TEXT id with an invalid UUID MUST abort safely", () => {
    const plan = planIdConversion(
      { udtName: "text", dataType: "text" },
      ["11111111-1111-4111-8111-111111111111", "not-a-uuid", "also-bad"],
    );
    expect(plan.action).toBe("abort");
    if (plan.action === "abort") {
      expect(plan.reason).toContain("not valid UUID strings");
      expect(plan.reason).toContain("not-a-uuid");
      expect(plan.reason).toContain("Existing data was NOT modified");
    }
  });

  it("leaves correct timestamptz/jsonb types unchanged", () => {
    expect(
      planTimestamptzConversion({ udtName: "timestamptz", dataType: "timestamp with time zone" }).action,
    ).toBe("noop");
    expect(planJsonbConversion({ udtName: "jsonb", dataType: "jsonb" }).action).toBe("noop");
  });

  it("aborts timestamp-without-time-zone instead of inventing a timezone", () => {
    const plan = planTimestamptzConversion({
      udtName: "timestamp",
      dataType: "timestamp without time zone",
    });
    expect(plan.action).toBe("abort");
    if (plan.action === "abort") {
      expect(plan.reason).toContain("explicit timezone assumption is required");
      expect(plan.reason).toContain("Existing data was NOT modified");
    }
  });

  it("converts date/text timestamps and json/text skills safely", () => {
    expect(planTimestamptzConversion({ udtName: "date", dataType: "date" }).action).toBe("convert");
    expect(planTimestamptzConversion({ udtName: "text", dataType: "text" }).action).toBe("convert");
    expect(planJsonbConversion({ udtName: "json", dataType: "json" }).action).toBe("convert");
    expect(planJsonbConversion({ udtName: "text", dataType: "text" }).action).toBe("convert");
  });
});
