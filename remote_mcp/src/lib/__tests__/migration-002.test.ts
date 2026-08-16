import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LIVE_POC_POSTED_DATE_COLUMN,
  OPTIONAL_LEGACY_JOB_COLUMNS,
  POST_MIGRATION_NULLABILITY,
  REQUIRED_COLUMNS_ENFORCED_AFTER_REPAIR,
  REQUIRED_LEGACY_JOB_COLUMNS,
  convertLegacyPostedDateText,
  isValidUuidString,
  mayReplaceExistingNonNullIds,
  planIdConversion,
  planJsonbConversion,
  planPostedDateTextConversionPrerequisites,
  planTimestamptzConversion,
  requiresExplicitTransaction,
} from "@/lib/db/migrationCompatibility";

const migrationPath = path.resolve(
  __dirname,
  "../../../migrations/002_neon_poc_compatibility.sql",
);
const fixturePath = path.resolve(
  __dirname,
  "../../../migrations/fixtures/neon_poc_legacy_jobs.sql",
);
const partialFixturePath = path.resolve(
  __dirname,
  "../../../migrations/fixtures/neon_poc_partial_no_updated_at.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const fixtureSql = readFileSync(fixturePath, "utf8");
const partialFixtureSql = readFileSync(partialFixturePath, "utf8");

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

  it("does not invent duplicate decisions or UNIQUE(url)", () => {
    const withoutComments = migrationSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(withoutComments).not.toMatch(/UNIQUE\s*\(\s*url\s*\)/i);
    expect(withoutComments).not.toMatch(
      /CREATE UNIQUE INDEX[^\n]*\bON\s+jobs\s*\(\s*url\s*\)/i,
    );
    // Non-unique url index is allowed / expected.
    expect(withoutComments).toMatch(/CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs \(url\)/);
  });

  it("does not auto-backfill lifecycle tables", () => {
    expect(migrationSql).not.toMatch(/canonical_jobs|job_postings|applications|discovery_runs/i);
  });
});

describe("live Neon PoC posted_date TEXT NOT NULL DEFAULT '' regression", () => {
  it("fixture represents the real failing PoC shape", () => {
    expect(fixtureSql).toMatch(/posted_date TEXT NOT NULL DEFAULT ''/);
    expect(fixtureSql).toContain("11111111-1111-4111-8111-111111111111");
    expect(fixtureSql).toContain("'2026-08-12'");
    expect(fixtureSql).toMatch(/posted_date[\s\S]*''/);
  });

  it("drops posted_date DEFAULT and NOT NULL before TIMESTAMPTZ conversion", () => {
    const alignStart = migrationSql.indexOf("Align optional legacy columns");
    expect(alignStart).toBeGreaterThan(-1);

    const dropDefaultIdx = migrationSql.indexOf(
      "ALTER TABLE jobs ALTER COLUMN %I DROP DEFAULT",
      alignStart,
    );
    const dropNotNullIdx = migrationSql.indexOf(
      "ALTER TABLE jobs ALTER COLUMN %I DROP NOT NULL",
      alignStart,
    );
    const typeConvertIdx = migrationSql.indexOf(
      "TYPE TIMESTAMPTZ USING NULLIF(btrim(%I::text), '''')::timestamptz",
      alignStart,
    );

    expect(dropDefaultIdx).toBeGreaterThan(-1);
    expect(dropNotNullIdx).toBeGreaterThan(dropDefaultIdx);
    expect(typeConvertIdx).toBeGreaterThan(dropNotNullIdx);

    // Defensive DROP DEFAULT also appears immediately before text TYPE change.
    const textBranchDropDefault = migrationSql.indexOf(
      "Live PoC: posted_date TEXT NOT NULL DEFAULT ''",
    );
    expect(textBranchDropDefault).toBeGreaterThan(-1);
    expect(migrationSql.slice(textBranchDropDefault)).toContain(
      "ALTER TABLE jobs ALTER COLUMN %I DROP DEFAULT",
    );
  });

  it("aligns all optional legacy fields and does not relax required ones", () => {
    for (const col of OPTIONAL_LEGACY_JOB_COLUMNS) {
      expect(migrationSql).toContain(`'${col}'`);
    }
    // Required columns must not appear in the optional DROP NOT NULL list.
    const optionalBlock = migrationSql.slice(
      migrationSql.indexOf("Align optional legacy columns"),
      migrationSql.indexOf("Repair posted_date / created_at / updated_at"),
    );
    for (const col of REQUIRED_LEGACY_JOB_COLUMNS) {
      if (col === "created_at" || col === "updated_at") {
        // converted later; must not be in optional DROP NOT NULL list
      }
      expect(optionalBlock).not.toContain(`'${col}'`);
    }
    expect(optionalBlock).not.toContain("'company'");
    expect(optionalBlock).not.toContain("'title'");
    expect(optionalBlock).not.toContain("'url'");
    expect(optionalBlock).not.toContain("'id'");
    expect(optionalBlock).not.toContain("'required_skills'");
    expect(optionalBlock).not.toContain("'preferred_skills'");
    expect(optionalBlock).not.toContain("'created_at'");
    expect(optionalBlock).not.toContain("'updated_at'");
  });

  it("does not restore an empty-string default on posted_date after conversion", () => {
    expect(migrationSql).not.toMatch(
      /ALTER TABLE jobs ALTER COLUMN posted_date SET DEFAULT\s+''/i,
    );
    expect(migrationSql).not.toMatch(
      /ALTER TABLE jobs ALTER COLUMN posted_date SET DEFAULT\s+""/i,
    );
  });

  it("plans DROP DEFAULT + DROP NOT NULL for the live PoC posted_date column", () => {
    const prerequisites = planPostedDateTextConversionPrerequisites(
      LIVE_POC_POSTED_DATE_COLUMN,
    );
    expect(prerequisites.dropDefault).toBe(true);
    expect(prerequisites.dropNotNull).toBe(true);
    expect(prerequisites.using).toBe("NULLIF(btrim(col::text), '')::timestamptz");
  });

  it("preserves valid ISO posted_date and converts blank '' to NULL", () => {
    const preservedId = "11111111-1111-4111-8111-111111111111";
    expect(isValidUuidString(preservedId)).toBe(true);

    const converted = convertLegacyPostedDateText("2026-08-12");
    expect(converted).toBeInstanceOf(Date);
    expect(converted?.toISOString().startsWith("2026-08-12")).toBe(true);

    expect(convertLegacyPostedDateText("")).toBeNull();
    expect(convertLegacyPostedDateText("   ")).toBeNull();
  });

  it("keeps row identity stable across the PoC fixture scenario", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const plan = planIdConversion({ udtName: "text", dataType: "text" }, ids);
    expect(plan.action).toBe("convert");
    expect(mayReplaceExistingNonNullIds()).toBe(false);
    expect(ids.every(isValidUuidString)).toBe(true);
  });
});

describe("partial PoC missing updated_at → enforce required NOT NULL after repair", () => {
  it("fixture omits updated_at before migration", () => {
    const createTable = partialFixtureSql.slice(
      partialFixtureSql.indexOf("CREATE TABLE jobs"),
      partialFixtureSql.indexOf("INSERT INTO jobs"),
    );
    expect(createTable).not.toMatch(/\bupdated_at\b/i);
    expect(partialFixtureSql).toContain("33333333-3333-4333-8333-333333333333");
    expect(partialFixtureSql).toContain("'2026-08-12'");
    expect(partialFixtureSql).toMatch(/posted_date TEXT NOT NULL DEFAULT ''/);
  });

  it("adds updated_at when absent, then fills NULLs before SET NOT NULL", () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW\(\)/,
    );

    const fillSkills = migrationSql.indexOf(
      "UPDATE jobs SET required_skills = '[]'::jsonb WHERE required_skills IS NULL",
    );
    const fillPreferred = migrationSql.indexOf(
      "UPDATE jobs SET preferred_skills = '[]'::jsonb WHERE preferred_skills IS NULL",
    );
    const fillCreated = migrationSql.indexOf(
      "UPDATE jobs SET created_at = NOW() WHERE created_at IS NULL",
    );
    const fillUpdated = migrationSql.indexOf(
      "UPDATE jobs SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL",
    );

    expect(fillSkills).toBeGreaterThan(-1);
    expect(fillPreferred).toBeGreaterThan(fillSkills);
    expect(fillCreated).toBeGreaterThan(fillPreferred);
    expect(fillUpdated).toBeGreaterThan(fillCreated);

    for (const col of REQUIRED_COLUMNS_ENFORCED_AFTER_REPAIR) {
      const setNotNull = migrationSql.indexOf(
        `ALTER TABLE jobs ALTER COLUMN ${col} SET NOT NULL`,
      );
      expect(setNotNull).toBeGreaterThan(fillUpdated);
    }
  });

  it("enforces required NOT NULL and keeps optional columns nullable", () => {
    for (const col of POST_MIGRATION_NULLABILITY.requiredNotNull) {
      expect(migrationSql).toContain(
        `ALTER TABLE jobs ALTER COLUMN ${col} SET NOT NULL`,
      );
    }
    for (const col of POST_MIGRATION_NULLABILITY.optionalNullable) {
      expect(migrationSql).not.toMatch(
        new RegExp(`ALTER TABLE jobs ALTER COLUMN ${col} SET NOT NULL`, "i"),
      );
    }
    // Optional alignment still drops NOT NULL for these fields.
    for (const col of OPTIONAL_LEGACY_JOB_COLUMNS) {
      expect(migrationSql).toContain(`'${col}'`);
    }
  });

  it("remains idempotent: SET NOT NULL and ADD COLUMN IF NOT EXISTS are re-runnable", () => {
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS updated_at/);
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS created_at/);
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS required_skills/);
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS preferred_skills/);
    // Re-applying SET NOT NULL on already-NOT-NULL columns is a no-op in Postgres.
    expect(
      (migrationSql.match(/ALTER COLUMN required_skills SET NOT NULL/g) || []).length,
    ).toBe(1);
    expect(
      (migrationSql.match(/ALTER COLUMN updated_at SET NOT NULL/g) || []).length,
    ).toBe(1);
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
