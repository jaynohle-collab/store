-- Non-destructive compatibility migration for the deployed Neon PoC.
--
-- Run after 001_initial.sql. Preserves existing rows and IDs.
-- Converts mistyped columns only when EVERY non-null value is safely castable.
-- Aborts with a descriptive exception if conversion would destroy or invent data.
-- No duplicate decisions or UNIQUE(url) constraint are introduced.
--
-- Atomic: the entire script runs in an explicit transaction (BEGIN/COMMIT).
-- Any raised exception rolls back ALL changes from this migration, so the
-- "Existing data was NOT modified" messages are accurate even if earlier steps
-- in this file already mutated the table within the same transaction.
--
-- Idempotent: safe to re-run when types are already correct.
--
-- Expected types after success:
--   id UUID
--   posted_date TIMESTAMPTZ
--   created_at TIMESTAMPTZ
--   updated_at TIMESTAMPTZ
--   required_skills JSONB
--   preferred_skills JSONB
--   description_hash TEXT  (unchanged)

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  IF to_regclass(format('%I.jobs', current_schema())) IS NULL THEN
    RAISE EXCEPTION
      'jobs table does not exist in schema %. Run 001_initial.sql first.',
      current_schema();
  END IF;
END
$$;

-- Add missing id only when absent. Never ADD COLUMN id UUID when a TEXT id
-- already exists — PostgreSQL would skip ADD and leave TEXT unchanged.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'jobs'
      AND column_name = 'id'
  ) THEN
    EXECUTE 'ALTER TABLE jobs ADD COLUMN id UUID DEFAULT gen_random_uuid()';
  END IF;
END
$$;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_hash TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_skills JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS preferred_skills JSONB DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS remote_status TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS posted_date TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Legacy PoC company_name → company (keep company_name intact).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'jobs'
      AND column_name = 'company_name'
  ) THEN
    EXECUTE 'UPDATE jobs SET company = company_name WHERE company IS NULL';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Repair jobs.id → UUID (preserve every existing non-null ID)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  id_udt text;
  id_data_type text;
  invalid_count bigint;
  sample_invalid text;
  null_count bigint;
BEGIN
  SELECT c.udt_name, c.data_type
  INTO id_udt, id_data_type
  FROM information_schema.columns c
  WHERE c.table_schema = current_schema()
    AND c.table_name = 'jobs'
    AND c.column_name = 'id';

  IF id_udt IS NULL THEN
    RAISE EXCEPTION 'jobs.id column is missing after additive migration steps';
  END IF;

  IF id_udt = 'uuid' THEN
    EXECUTE 'UPDATE jobs SET id = gen_random_uuid() WHERE id IS NULL';
    EXECUTE 'ALTER TABLE jobs ALTER COLUMN id SET DEFAULT gen_random_uuid()';

    SELECT COUNT(*) INTO null_count FROM jobs WHERE id IS NULL;
    IF null_count = 0 THEN
      BEGIN
        EXECUTE 'ALTER TABLE jobs ALTER COLUMN id SET NOT NULL';
      EXCEPTION
        WHEN others THEN
          NULL; -- leave nullable if a concurrent write inserted NULL mid-migration
      END;
    END IF;

  ELSIF id_udt IN ('text', 'varchar', 'bpchar')
        OR id_data_type IN ('text', 'character varying', 'character') THEN
    -- Validate EVERY non-null value. Do NOT replace invalid or existing IDs.
    EXECUTE $validate$
      SELECT COUNT(*), MIN(btrim(id::text))
      FROM jobs
      WHERE id IS NOT NULL
        AND btrim(id::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    $validate$
    INTO invalid_count, sample_invalid;

    IF COALESCE(invalid_count, 0) > 0 THEN
      RAISE EXCEPTION
        'Cannot convert jobs.id from % (%) to UUID: % non-null value(s) are not valid UUID strings (example: %). Existing data was NOT modified. Fix invalid IDs manually, then re-run this migration.',
        id_data_type, id_udt, invalid_count, sample_invalid;
    END IF;

    BEGIN
      EXECUTE 'ALTER TABLE jobs ALTER COLUMN id TYPE UUID USING btrim(id::text)::uuid';
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION
          'Cannot convert jobs.id from % (%) to UUID: cast failed (%). Existing data was NOT modified.',
          id_data_type, id_udt, SQLERRM;
    END;

    EXECUTE 'ALTER TABLE jobs ALTER COLUMN id SET DEFAULT gen_random_uuid()';
    EXECUTE 'UPDATE jobs SET id = gen_random_uuid() WHERE id IS NULL';

    SELECT COUNT(*) INTO null_count FROM jobs WHERE id IS NULL;
    IF null_count = 0 THEN
      BEGIN
        EXECUTE 'ALTER TABLE jobs ALTER COLUMN id SET NOT NULL';
      EXCEPTION
        WHEN others THEN
          NULL;
      END;
    END IF;

  ELSE
    RAISE EXCEPTION
      'Cannot convert jobs.id from unsupported type % (%) to UUID. Existing data was NOT modified.',
      id_data_type, id_udt;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Repair posted_date / created_at / updated_at → TIMESTAMPTZ
--
-- TIMESTAMP WITHOUT TIME ZONE is NOT auto-converted: AT TIME ZONE requires an
-- explicit zone, and this repository has no conclusive evidence that the Neon
-- PoC stored naive timestamps as UTC. Abort instead of inventing a zone.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col_name text;
  col_udt text;
  col_data_type text;
  invalid_count bigint;
  sample_invalid text;
BEGIN
  FOREACH col_name IN ARRAY ARRAY['posted_date', 'created_at', 'updated_at']
  LOOP
    SELECT c.udt_name, c.data_type
    INTO col_udt, col_data_type
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = 'jobs'
      AND c.column_name = col_name;

    IF col_udt IS NULL OR col_udt = 'timestamptz' THEN
      CONTINUE;
    ELSIF col_udt = 'timestamp'
          OR col_data_type = 'timestamp without time zone' THEN
      RAISE EXCEPTION
        'Cannot convert jobs.% from TIMESTAMP WITHOUT TIME ZONE to TIMESTAMPTZ: an explicit timezone assumption is required, and this repository does not document UTC (or any other) semantics for legacy PoC timestamps. Existing data was NOT modified. Convert the column manually with an explicit zone only after confirming the historical meaning (example: ALTER TABLE jobs ALTER COLUMN % TYPE TIMESTAMPTZ USING % AT TIME ZONE ''UTC''), then re-run this migration.',
        col_name, col_name, col_name;
    ELSIF col_udt = 'date' THEN
      EXECUTE format(
        'ALTER TABLE jobs ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I::timestamptz',
        col_name, col_name
      );
    ELSIF col_udt IN ('text', 'varchar', 'bpchar')
          OR col_data_type IN ('text', 'character varying', 'character') THEN
      EXECUTE format(
        $q$
          SELECT COUNT(*), MIN(btrim(%1$I::text))
          FROM jobs
          WHERE %1$I IS NOT NULL
            AND btrim(%1$I::text) <> ''
            AND btrim(%1$I::text) !~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        $q$,
        col_name
      )
      INTO invalid_count, sample_invalid;

      IF COALESCE(invalid_count, 0) > 0 THEN
        RAISE EXCEPTION
          'Cannot convert jobs.% from % (%) to TIMESTAMPTZ: % non-null value(s) are not safely convertible (example: %). Existing data was NOT modified.',
          col_name, col_data_type, col_udt, invalid_count, sample_invalid;
      END IF;

      BEGIN
        EXECUTE format(
          'ALTER TABLE jobs ALTER COLUMN %I TYPE TIMESTAMPTZ USING NULLIF(btrim(%I::text), '''')::timestamptz',
          col_name, col_name
        );
      EXCEPTION
        WHEN others THEN
          RAISE EXCEPTION
            'Cannot convert jobs.% from % (%) to TIMESTAMPTZ: cast failed (%). Existing data was NOT modified.',
            col_name, col_data_type, col_udt, SQLERRM;
      END;
    ELSE
      RAISE EXCEPTION
        'Cannot convert jobs.% from unsupported type % (%) to TIMESTAMPTZ. Existing data was NOT modified.',
        col_name, col_data_type, col_udt;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Repair required_skills / preferred_skills → JSONB
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  col_name text;
  col_udt text;
  col_data_type text;
BEGIN
  FOREACH col_name IN ARRAY ARRAY['required_skills', 'preferred_skills']
  LOOP
    SELECT c.udt_name, c.data_type
    INTO col_udt, col_data_type
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = 'jobs'
      AND c.column_name = col_name;

    IF col_udt IS NULL OR col_udt = 'jsonb' THEN
      CONTINUE;
    ELSIF col_udt = 'json' THEN
      EXECUTE format(
        'ALTER TABLE jobs ALTER COLUMN %I TYPE JSONB USING %I::jsonb',
        col_name, col_name
      );
    ELSIF col_udt IN ('text', 'varchar', 'bpchar')
          OR col_data_type IN ('text', 'character varying', 'character') THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE jobs ALTER COLUMN %I TYPE JSONB USING COALESCE(NULLIF(btrim(%I::text), ''''), ''[]'')::jsonb',
          col_name, col_name
        );
      EXCEPTION
        WHEN others THEN
          RAISE EXCEPTION
            'Cannot convert jobs.% from % (%) to JSONB: one or more values are not valid JSON (%). Existing data was NOT modified.',
            col_name, col_data_type, col_udt, SQLERRM;
      END;
    ELSE
      RAISE EXCEPTION
        'Cannot convert jobs.% from unsupported type % (%) to JSONB. Existing data was NOT modified.',
        col_name, col_data_type, col_udt;
    END IF;
  END LOOP;
END
$$;

UPDATE jobs SET required_skills = '[]'::jsonb WHERE required_skills IS NULL;
UPDATE jobs SET preferred_skills = '[]'::jsonb WHERE preferred_skills IS NULL;
UPDATE jobs SET created_at = NOW() WHERE created_at IS NULL;
UPDATE jobs SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

ALTER TABLE jobs ALTER COLUMN required_skills SET DEFAULT '[]'::jsonb;
ALTER TABLE jobs ALTER COLUMN preferred_skills SET DEFAULT '[]'::jsonb;
ALTER TABLE jobs ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE jobs ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE jobs ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- description_hash remains TEXT.

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_storage_id ON jobs (id);
CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs (url);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs (company);
CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs (title);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_date ON jobs (posted_date);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);

COMMIT;
