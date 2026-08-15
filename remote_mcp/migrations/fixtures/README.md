# Neon PoC compatibility migration fixtures

These fixtures document the verification cases for
`002_neon_poc_compatibility.sql`.

Apply a fixture against a disposable database, then run the migration.

## Scenarios

### 1. New schema (`01_new_schema.sql`)
Expected: migration succeeds (idempotent). `id` remains UUID.

### 2. Existing UUID id (`02_uuid_id.sql`)
Expected: migration succeeds. Existing UUID values are preserved.
Only NULL ids are backfilled.

### 3. TEXT id with valid UUID strings (`03_text_valid_uuids.sql`)
Expected: migration succeeds. Column becomes UUID via
`USING btrim(id::text)::uuid`. Existing string IDs are preserved exactly.

### 4. TEXT id with an invalid UUID (`04_text_invalid_uuid.sql`)
Expected: migration **fails** with an exception containing:
`Cannot convert jobs.id ... not valid UUID strings`
and `Existing data was NOT modified`.
No rows deleted. Invalid TEXT ids remain unchanged.

## Manual verification

```bash
# Example against a local/disposable Postgres:
psql "$DATABASE_URL" -f remote_mcp/migrations/fixtures/04_text_invalid_uuid.sql
psql "$DATABASE_URL" -f remote_mcp/migrations/002_neon_poc_compatibility.sql
# expect: ERROR ... not valid UUID strings ... Existing data was NOT modified
```
