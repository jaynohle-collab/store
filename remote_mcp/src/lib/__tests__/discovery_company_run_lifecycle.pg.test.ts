/**
 * Real PostgreSQL execution tests for company-run complete/fail lifecycle SQL.
 * Uses ephemeral in-process PGlite (never production Neon / Auth0).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEphemeralPglite,
  type PgliteSql,
} from "./helpers/pglite_sql";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "github-actions";

const { dbState } = vi.hoisted(() => ({
  dbState: { sql: null as PgliteSql | null },
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    if (!dbState.sql) throw new Error("pglite sql not initialized");
    return dbState.sql;
  },
  getTransactionalSql: () => {
    if (!dbState.sql) throw new Error("pglite sql not initialized");
    return dbState.sql;
  },
  resetSqlClient: () => undefined,
}));

const {
  completeDiscoveryCompanyRun,
  failDiscoveryCompanyRun,
} = await import("@/lib/db/discovery_companies");

async function seedClaimed(opts?: {
  worker?: string;
  activeRunId?: string | null;
  status?: "claimed" | "completed" | "failed" | "expired";
  otherClaimed?: boolean;
}) {
  const sql = dbState.sql!;
  await sql.raw.exec(`
    TRUNCATE discovery_company_runs, discovery_companies CASCADE;
  `);

  const worker = opts?.worker ?? OWNER;
  const status = opts?.status ?? "claimed";
  const active =
    opts?.activeRunId === undefined ? RUN_ID : opts.activeRunId;

  await sql.raw.query(
    `INSERT INTO discovery_companies (
       id, company_key, company_name, ats_provider, ats_org_id,
       enabled, scan_priority, consecutive_failures, active_run_id, lease_expires_at
     ) VALUES ($1, 'acme', 'Acme', 'greenhouse', 'acme', FALSE, 'manual', 0, NULL, NULL)`,
    [COMPANY_ID],
  );

  await sql.raw.query(
    `INSERT INTO discovery_company_runs (
       id, company_id, status, worker_identity, lease_expires_at
     ) VALUES ($1, $2, $3, $4, NOW() + interval '30 minutes')`,
    [RUN_ID, COMPANY_ID, status, worker],
  );

  if (opts?.otherClaimed || (active && active !== RUN_ID)) {
    await sql.raw.query(
      `INSERT INTO discovery_company_runs (
         id, company_id, status, worker_identity, lease_expires_at
       ) VALUES ($1, $2, 'claimed', 'fresh-worker', NOW() + interval '30 minutes')`,
      [OTHER_RUN_ID, COMPANY_ID],
    );
  }

  if (active) {
    await sql.raw.query(
      `UPDATE discovery_companies
       SET active_run_id = $1::uuid,
           lease_expires_at = NOW() + interval '30 minutes'
       WHERE id = $2::uuid`,
      [active, COMPANY_ID],
    );
  }
}

async function snapshot() {
  const sql = dbState.sql!;
  const companies = await sql.raw.query(
    `SELECT id, active_run_id::text AS active_run_id, consecutive_failures,
            last_error_category, last_error_summary
     FROM discovery_companies WHERE id = $1::uuid`,
    [COMPANY_ID],
  );
  const runs = await sql.raw.query(
    `SELECT id::text AS id, status, worker_identity, error_category, error_summary
     FROM discovery_company_runs ORDER BY id`,
  );
  return {
    company: companies.rows[0] as Record<string, unknown>,
    runs: runs.rows as Record<string, unknown>[],
  };
}

describe("discovery company run lifecycle (real PostgreSQL)", () => {
  beforeEach(async () => {
    dbState.sql = await createEphemeralPglite();
    await seedClaimed();
  });

  it("correct owner completes and clears the lease (no planning-time 1/0)", async () => {
    const result = await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: OWNER,
      success: true,
      metrics: { jobs: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.idempotent_replay).toBe(false);

    const snap = await snapshot();
    expect(snap.runs.find((r) => r.id === RUN_ID)?.status).toBe("completed");
    expect(snap.company.active_run_id).toBeNull();
    expect(snap.company.consecutive_failures).toBe(0);
  });

  it("correct owner fails and clears the lease", async () => {
    const result = await failDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: OWNER,
      error_category: "not_found",
      error_summary: "gemini 404",
      metrics: {},
    });
    expect(result.ok).toBe(true);
    expect(result.idempotent_replay).toBe(false);

    const snap = await snapshot();
    expect(snap.runs.find((r) => r.id === RUN_ID)?.status).toBe("failed");
    expect(snap.company.active_run_id).toBeNull();
    expect(snap.company.consecutive_failures).toBe(1);
    expect(snap.company.last_error_category).toBe("not_found");
  });

  it("wrong owner changes neither row", async () => {
    const before = await snapshot();
    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: "intruder",
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/owner_mismatch/);
    expect(await snapshot()).toEqual(before);
  });

  it("replaced active_run_id changes neither row", async () => {
    await seedClaimed({ activeRunId: OTHER_RUN_ID, otherClaimed: true });
    const before = await snapshot();

    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: OWNER,
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/lease_not_active/);

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.runs.find((r) => r.id === RUN_ID)?.status).toBe("claimed");
    expect(after.company.active_run_id).toBe(OTHER_RUN_ID);
  });

  it("expired worker response changes neither row", async () => {
    await seedClaimed({
      status: "expired",
      activeRunId: OTHER_RUN_ID,
      otherClaimed: true,
    });
    const before = await snapshot();

    await expect(
      completeDiscoveryCompanyRun({
        run_id: RUN_ID,
        worker_identity: OWNER,
        success: true,
        metrics: {},
      }),
    ).rejects.toThrow(/not_claimable:expired/);

    expect(await snapshot()).toEqual(before);
  });

  it("same-owner replay is idempotent", async () => {
    await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: OWNER,
      success: true,
      metrics: {},
    });
    const afterFirst = await snapshot();

    const again = await completeDiscoveryCompanyRun({
      run_id: RUN_ID,
      worker_identity: OWNER,
      success: true,
      metrics: { jobs: 99 },
    });
    expect(again.idempotent_replay).toBe(true);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("forced mid-statement failure rolls back both mutations", async () => {
    // Prove data-modifying CTEs are atomic: both UPDATEs then a CHECK violation
    // in the same statement must leave neither row changed.
    const before = await snapshot();
    const sql = dbState.sql!;

    await expect(
      sql.raw.query(
        `
        WITH eligible AS (
          SELECT
            r.id AS run_id,
            r.company_id
          FROM discovery_company_runs r
          INNER JOIN discovery_companies c
            ON c.id = r.company_id
           AND c.active_run_id = r.id
          WHERE r.id = $1::uuid
            AND r.status = 'claimed'
            AND r.worker_identity = $2
          FOR UPDATE OF r, c
        ),
        done AS (
          UPDATE discovery_company_runs r
          SET status = 'completed',
              completed_at = NOW(),
              updated_at = NOW()
          FROM eligible e
          WHERE r.id = e.run_id
          RETURNING r.id
        ),
        company AS (
          UPDATE discovery_companies c
          SET active_run_id = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          FROM eligible e
          WHERE c.id = e.company_id
            AND c.active_run_id = e.run_id
          RETURNING c.id
        ),
        boom AS (
          UPDATE discovery_company_runs r
          SET status = 'not_a_valid_status'
          FROM done d
          WHERE r.id = d.id
          RETURNING r.id
        )
        SELECT d.id FROM done d CROSS JOIN boom
      `,
        [RUN_ID, OWNER],
      ),
    ).rejects.toThrow(/check|violat|invalid|not_a_valid_status/i);

    expect(await snapshot()).toEqual(before);
    expect(before.runs.find((r) => r.id === RUN_ID)?.status).toBe("claimed");
    expect(before.company.active_run_id).toBe(RUN_ID);
  });
});
