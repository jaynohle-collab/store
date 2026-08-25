import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { getDatabaseUrl } from "../config";

export type Sql = NeonQueryFunction<false, false>;

export type NeonQuery = ReturnType<Sql>;

export type SqlWithTransaction = Sql & {
  transaction: (
    queries: NeonQuery[],
    options?: { isolationLevel?: string },
  ) => Promise<Array<Record<string, unknown>[]>>;
};

let sqlClient: Sql | undefined;

export function getSql(): Sql {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!sqlClient) {
    sqlClient = neon(databaseUrl);
  }
  return sqlClient;
}

/**
 * Neon HTTP driver transactional API. Destructive multi-statement work
 * (batch revert, atomic worker apply) MUST use this and fail closed when
 * unavailable — never fall back to sequential statements.
 */
export function getTransactionalSql(): SqlWithTransaction {
  const sql = getSql() as SqlWithTransaction;
  if (typeof sql.transaction !== "function") {
    throw new Error(
      "neon_transaction_unavailable: refusing destructive multi-statement work without sql.transaction",
    );
  }
  return sql;
}

export async function runInTransaction<T>(
  build: (sql: SqlWithTransaction) => NeonQuery[],
  interpret: (results: Array<Record<string, unknown>[]>) => T,
): Promise<T> {
  const sql = getTransactionalSql();
  const queries = build(sql);
  const results = await sql.transaction(queries);
  return interpret(results);
}

/** Reset SQL client cache (tests only). */
export function resetSqlClient(): void {
  sqlClient = undefined;
}
