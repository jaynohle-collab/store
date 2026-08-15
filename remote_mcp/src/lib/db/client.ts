import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { getDatabaseUrl } from "../config";

export type Sql = NeonQueryFunction<false, false>;

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

/** Reset SQL client cache (tests only). */
export function resetSqlClient(): void {
  sqlClient = undefined;
}
