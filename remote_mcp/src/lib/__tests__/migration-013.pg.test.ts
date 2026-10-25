import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPgliteFromMigrations } from "./helpers/pglite_sql";

const sql013 = readFileSync(
  path.resolve(__dirname, "../../../migrations/013_gpt_fit_v2_hybrid_threshold_60.sql"),
  "utf8",
);

describe("013_gpt_fit_v2_hybrid_threshold_60.sql", () => {
  it("only replaces the QUALIFIED check, transactionally", () => {
    expect(sql013).toMatch(/^BEGIN;/m);
    expect(sql013).toMatch(/^COMMIT;/m);
    expect(sql013).not.toMatch(/DROP TABLE|DELETE FROM|UPDATE /i);
    expect(sql013).toContain("DROP CONSTRAINT IF EXISTS discovery_gpt_evaluations_gpt_fit_v2_qualified_check");
  });

  it("final schema allows US hybrid/restricted with score >= 60", async () => {
    const sql = await createPgliteFromMigrations();
    const rows = (await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'discovery_gpt_evaluations_gpt_fit_v2_qualified_check'
    `) as Array<{ def: string }>;
    expect(rows).toHaveLength(1);
    const def = rows[0].def;
    expect(def).toContain("HYBRID");
    expect(def).toContain("US_RESTRICTED");
    expect(def).toContain(">= 60");
    expect(def).not.toContain(">= 70");
  }, 60_000);
});
