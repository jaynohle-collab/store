/**
 * Neon-compatible tagged-template SQL + transaction adapter over PGlite.
 * Used only by local PostgreSQL integration tests — never production Neon.
 */

import { PGlite } from "@electric-sql/pglite";

type QueryHandle = Promise<Record<string, unknown>[]> & {
  text: string;
  params: unknown[];
};

function buildQuery(
  strings: TemplateStringsArray,
  values: unknown[],
): { text: string; params: unknown[] } {
  let text = strings[0] ?? "";
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    params.push(values[i]);
    text += `$${params.length}${strings[i + 1] ?? ""}`;
  }
  return { text, params };
}

export type PgliteSql = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => QueryHandle) & {
  transaction: (
    queries: QueryHandle[],
  ) => Promise<Array<Record<string, unknown>[]>>;
  raw: PGlite;
};

export function createPgliteSql(db: PGlite): PgliteSql {
  const run = async (
    text: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> => {
    const result = await db.query(text, params);
    return (result.rows as Record<string, unknown>[]) ?? [];
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, params } = buildQuery(strings, values);
    // Lazy thenable: do not execute until awaited or pulled by transaction.
    const handle = {
      text,
      params,
      then(
        onFulfilled?: (value: Record<string, unknown>[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return run(text, params).then(onFulfilled, onRejected);
      },
      catch(onRejected?: (reason: unknown) => unknown) {
        return run(text, params).catch(onRejected);
      },
    } as QueryHandle;
    return handle;
  }) as PgliteSql;

  sql.raw = db;

  sql.transaction = async (queries) => {
    // Execute the batch inside one PGlite transaction so statement/CTE failures
    // roll back every mutation in the batch (mirrors neon sql.transaction).
    return db.transaction(async (tx) => {
      const out: Array<Record<string, unknown>[]> = [];
      for (const q of queries) {
        const result = await tx.query(q.text, q.params);
        out.push((result.rows as Record<string, unknown>[]) ?? []);
      }
      return out;
    });
  };

  return sql;
}

export async function createEphemeralPglite(): Promise<PgliteSql> {
  const db = new PGlite();
  const sql = createPgliteSql(db);
  await db.exec(`
    CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid AS $$
      SELECT (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 9, 4) || '-' ||
        '4' || substr(md5(random()::text || clock_timestamp()::text), 14, 3) || '-' ||
        substr('89ab', 1 + (random() * 3)::int, 1) ||
        substr(md5(random()::text || clock_timestamp()::text), 17, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 21, 12)
      )::uuid;
    $$ LANGUAGE SQL;

    CREATE TABLE discovery_companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_key TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      careers_url TEXT,
      ats_provider TEXT NOT NULL,
      ats_org_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      scan_priority TEXT NOT NULL DEFAULT 'normal',
      last_attempted_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      backoff_until TIMESTAMPTZ,
      last_error_category TEXT,
      last_error_summary TEXT,
      stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      active_run_id UUID,
      lease_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE discovery_company_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES discovery_companies (id),
      status TEXT NOT NULL,
      worker_identity TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      error_category TEXT,
      error_summary TEXT,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT discovery_company_runs_status_check CHECK (
        status IN ('claimed', 'completed', 'failed', 'expired')
      )
    );

    ALTER TABLE discovery_companies
      ADD CONSTRAINT discovery_companies_active_run_fkey
      FOREIGN KEY (active_run_id) REFERENCES discovery_company_runs (id);
  `);
  return sql;
}
