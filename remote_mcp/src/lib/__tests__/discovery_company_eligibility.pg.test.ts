/**
 * Backoff / force-scan / due-status eligibility regressions (production canary).
 * Uses ephemeral PGlite — never production Neon / Auth0.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEphemeralPglite,
  type PgliteSql,
} from "./helpers/pglite_sql";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_A = "11111111-1111-4111-8111-111111111111";
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
  claimDueDiscoveryCompanies,
  completeDiscoveryCompanyRun,
  getAutomaticDiscoveryStatus,
  upsertDiscoveryCompany,
} = await import("@/lib/db/discovery_companies");

async function seedCompany(opts: {
  id: string;
  key: string;
  enabled?: boolean;
  failures?: number;
  nextEligibleOffsetHours?: number;
  backoffOffsetHours?: number | null;
  activeRunId?: string | null;
}) {
  const sql = dbState.sql!;
  const nextOffset = opts.nextEligibleOffsetHours ?? -1;
  const backoffOffset = opts.backoffOffsetHours;
  await sql.raw.query(
    `INSERT INTO discovery_companies (
       id, company_key, company_name, ats_provider, ats_org_id,
       enabled, scan_priority, consecutive_failures,
       next_eligible_at, backoff_until, active_run_id, lease_expires_at
     ) VALUES (
       $1, $2, $3, 'greenhouse', $2, $4, 'normal', $5,
       NOW() + make_interval(hours => $6),
       CASE WHEN $7::int IS NULL THEN NULL
            ELSE NOW() + make_interval(hours => $7) END,
       $8::uuid,
       CASE WHEN $8::uuid IS NULL THEN NULL
            ELSE NOW() + interval '30 minutes' END
     )`,
    [
      opts.id,
      opts.key,
      opts.key,
      opts.enabled ?? true,
      opts.failures ?? 0,
      nextOffset,
      backoffOffset,
      opts.activeRunId ?? null,
    ],
  );
}

describe("discovery company backoff eligibility", () => {
  beforeEach(async () => {
    dbState.sql = await createEphemeralPglite();
    await dbState.sql.raw.exec(`
      CREATE TABLE IF NOT EXISTS discovery_inbox_batches (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS automatic_discovery_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        worker_identity TEXT,
        llm_provider TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_summary TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  });

  it("force_scan_now clears backoff_until and makes the company claimable", async () => {
    await seedCompany({
      id: COMPANY_A,
      key: "stripe",
      failures: 3,
      nextEligibleOffsetHours: -1,
      backoffOffsetHours: 48,
    });

    expect((await getAutomaticDiscoveryStatus()).due_companies).toBe(0);
    expect(
      (
        await claimDueDiscoveryCompanies({
          limit: 5,
          lease_minutes: 30,
          worker_identity: OWNER,
          recover_stale: false,
        })
      ).claims,
    ).toHaveLength(0);

    await upsertDiscoveryCompany({
      company_key: "stripe",
      company_name: "Stripe",
      ats_provider: "greenhouse",
      ats_org_id: "stripe",
      enabled: true,
      scan_priority: "normal",
      force_scan_now: true,
    });

    const row = (
      await dbState.sql!.raw.query(
        `SELECT next_eligible_at, backoff_until, consecutive_failures
         FROM discovery_companies WHERE company_key = 'stripe'`,
      )
    ).rows[0] as Record<string, unknown>;
    expect(row.backoff_until).toBeNull();
    expect(new Date(String(row.next_eligible_at)).getTime()).toBeLessThanOrEqual(
      Date.now() + 2000,
    );
    expect(Number(row.consecutive_failures)).toBe(3);

    expect((await getAutomaticDiscoveryStatus()).due_companies).toBe(1);

    const claimed = await claimDueDiscoveryCompanies({
      limit: 5,
      lease_minutes: 30,
      worker_identity: OWNER,
      recover_stale: false,
    });
    expect(claimed.claims).toHaveLength(1);
    expect(
      (claimed.claims[0] as { company: { company_key: string } }).company.company_key,
    ).toBe("stripe");
  });

  it("force_scan_now does not override an active lease", async () => {
    await seedCompany({
      id: COMPANY_A,
      key: "openai",
      nextEligibleOffsetHours: -1,
      backoffOffsetHours: 48,
    });
    await dbState.sql!.raw.query(
      `INSERT INTO discovery_company_runs (
         id, company_id, status, worker_identity, lease_expires_at
       ) VALUES ($1, $2, 'claimed', $3, NOW() + interval '30 minutes')`,
      [RUN_A, COMPANY_A, OWNER],
    );
    await dbState.sql!.raw.query(
      `UPDATE discovery_companies
       SET active_run_id = $1,
           lease_expires_at = NOW() + interval '30 minutes'
       WHERE id = $2`,
      [RUN_A, COMPANY_A],
    );

    await upsertDiscoveryCompany({
      company_key: "openai",
      company_name: "OpenAI",
      ats_provider: "ashby",
      ats_org_id: "openai",
      enabled: true,
      scan_priority: "hot",
      force_scan_now: true,
    });

    const row = (
      await dbState.sql!.raw.query(
        `SELECT active_run_id::text AS active_run_id, backoff_until
         FROM discovery_companies WHERE company_key = 'openai'`,
      )
    ).rows[0] as Record<string, unknown>;
    expect(row.active_run_id).toBe(RUN_A);
    expect(row.backoff_until).toBeNull();

    expect((await getAutomaticDiscoveryStatus()).due_companies).toBe(0);
    expect(
      (
        await claimDueDiscoveryCompanies({
          limit: 5,
          lease_minutes: 30,
          worker_identity: "other-worker",
          recover_stale: false,
        })
      ).claims,
    ).toHaveLength(0);
  });

  it("due-company count excludes active backoff and matches claim eligibility", async () => {
    await seedCompany({
      id: COMPANY_A,
      key: "due-ok",
      nextEligibleOffsetHours: -2,
      backoffOffsetHours: null,
    });
    await seedCompany({
      id: COMPANY_B,
      key: "in-backoff",
      nextEligibleOffsetHours: -2,
      backoffOffsetHours: 12,
    });

    expect((await getAutomaticDiscoveryStatus()).due_companies).toBe(1);

    const claimed = await claimDueDiscoveryCompanies({
      limit: 10,
      lease_minutes: 30,
      worker_identity: OWNER,
      recover_stale: false,
    });
    expect(claimed.claims).toHaveLength(1);
    expect(
      (claimed.claims[0] as { company: { company_key: string } }).company.company_key,
    ).toBe("due-ok");

    expect((await getAutomaticDiscoveryStatus()).due_companies).toBe(0);
  });

  it("deferred complete releases lease without failure backoff", async () => {
    await seedCompany({
      id: COMPANY_A,
      key: "acme",
      failures: 2,
      nextEligibleOffsetHours: -1,
      backoffOffsetHours: null,
    });
    await dbState.sql!.raw.query(
      `INSERT INTO discovery_company_runs (
         id, company_id, status, worker_identity, lease_expires_at
       ) VALUES ($1, $2, 'claimed', $3, NOW() + interval '30 minutes')`,
      [RUN_A, COMPANY_A, OWNER],
    );
    await dbState.sql!.raw.query(
      `UPDATE discovery_companies
       SET active_run_id = $1, lease_expires_at = NOW() + interval '30 minutes'
       WHERE id = $2`,
      [RUN_A, COMPANY_A],
    );

    const result = await completeDiscoveryCompanyRun({
      run_id: RUN_A,
      worker_identity: OWNER,
      success: true,
      deferred: true,
      metrics: { deferred_reason: "max_evals_reached" },
    });
    expect(result.deferred).toBe(true);

    const snap = (
      await dbState.sql!.raw.query(
        `SELECT consecutive_failures, backoff_until, active_run_id::text AS active_run_id,
                (next_eligible_at <= NOW()) AS due_now
         FROM discovery_companies WHERE id = $1`,
        [COMPANY_A],
      )
    ).rows[0] as Record<string, unknown>;
    expect(Number(snap.consecutive_failures)).toBe(2);
    expect(snap.backoff_until).toBeNull();
    expect(snap.active_run_id).toBeNull();
    expect(Boolean(snap.due_now)).toBe(true);

    const run = (
      await dbState.sql!.raw.query(
        `SELECT status FROM discovery_company_runs WHERE id = $1`,
        [RUN_A],
      )
    ).rows[0] as Record<string, unknown>;
    expect(run.status).toBe("completed");
  });
});
