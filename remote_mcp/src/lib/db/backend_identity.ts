import { z } from "zod";

import { getSql } from "./client";

const databaseRoleSchema = z.string().min(1).max(63).refine(
  (value) => value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= 63
    && !/[\u0000-\u001f\u007f]/.test(value),
);

/** A fixed metadata read, never an environment/connection-string fallback. */
export async function getBackendDatabaseRole(): Promise<{ database_role: string }> {
  const sql = getSql();
  const rows = await sql`SELECT current_user::text AS database_role`;
  if (rows.length !== 1) throw new Error("backend_identity_unavailable");
  const databaseRole = databaseRoleSchema.parse(rows[0]?.database_role);
  // Explicit projection: no extra database fields can enter the response.
  return { database_role: databaseRole };
}
