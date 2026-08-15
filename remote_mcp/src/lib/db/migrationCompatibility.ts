/**
 * Decision helpers mirroring remote_mcp/migrations/002_neon_poc_compatibility.sql.
 * Used by unit tests to lock the migration safety contract without requiring Neon.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ColumnTypeInfo = {
  udtName: string;
  dataType: string;
};

export type ConversionPlan =
  | { action: "noop"; reason: string }
  | { action: "convert"; using: string }
  | { action: "abort"; reason: string };

export function isValidUuidString(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function planIdConversion(
  column: ColumnTypeInfo,
  nonNullValues: Array<string | null>,
): ConversionPlan {
  const udt = column.udtName.toLowerCase();
  const dataType = column.dataType.toLowerCase();

  if (udt === "uuid") {
    return { action: "noop", reason: "id is already UUID; preserve values and backfill NULLs only" };
  }

  const isTextLike =
    ["text", "varchar", "bpchar"].includes(udt) ||
    ["text", "character varying", "character"].includes(dataType);

  if (!isTextLike) {
    return {
      action: "abort",
      reason: `Cannot convert jobs.id from unsupported type ${column.dataType} (${column.udtName}) to UUID. Existing data was NOT modified.`,
    };
  }

  const invalid = nonNullValues
    .filter((value): value is string => value != null)
    .filter((value) => !isValidUuidString(value));

  if (invalid.length > 0) {
    return {
      action: "abort",
      reason: `Cannot convert jobs.id from ${column.dataType} (${column.udtName}) to UUID: ${invalid.length} non-null value(s) are not valid UUID strings (example: ${invalid[0]}). Existing data was NOT modified. Fix invalid IDs manually, then re-run this migration.`,
    };
  }

  return {
    action: "convert",
    using: "btrim(id::text)::uuid",
  };
}

export function planTimestamptzConversion(column: ColumnTypeInfo): ConversionPlan {
  const udt = column.udtName.toLowerCase();
  const dataType = column.dataType.toLowerCase();

  if (udt === "timestamptz") {
    return { action: "noop", reason: "already TIMESTAMPTZ" };
  }
  if (udt === "timestamp" || dataType === "timestamp without time zone") {
    return {
      action: "abort",
      reason:
        "Cannot convert TIMESTAMP WITHOUT TIME ZONE to TIMESTAMPTZ: an explicit timezone assumption is required, and this repository does not document UTC (or any other) semantics for legacy PoC timestamps. Existing data was NOT modified.",
    };
  }
  if (udt === "date") {
    return { action: "convert", using: "col::timestamptz" };
  }
  if (["text", "varchar", "bpchar"].includes(udt)) {
    return { action: "convert", using: "NULLIF(btrim(col::text), '')::timestamptz" };
  }
  return {
    action: "abort",
    reason: `Cannot convert from unsupported type ${column.dataType} (${column.udtName}) to TIMESTAMPTZ. Existing data was NOT modified.`,
  };
}

/** Migration 002 must be one atomic transaction so failed validation rolls everything back. */
export function requiresExplicitTransaction(): boolean {
  return true;
}

export function planJsonbConversion(column: ColumnTypeInfo): ConversionPlan {
  const udt = column.udtName.toLowerCase();
  if (udt === "jsonb") {
    return { action: "noop", reason: "already JSONB" };
  }
  if (udt === "json") {
    return { action: "convert", using: "col::jsonb" };
  }
  if (["text", "varchar", "bpchar"].includes(udt)) {
    return {
      action: "convert",
      using: "COALESCE(NULLIF(btrim(col::text), ''), '[]')::jsonb",
    };
  }
  return {
    action: "abort",
    reason: `Cannot convert from unsupported type ${column.dataType} (${column.udtName}) to JSONB`,
  };
}

/** Existing non-null IDs must never be replaced with freshly generated UUIDs. */
export function mayReplaceExistingNonNullIds(): boolean {
  return false;
}
