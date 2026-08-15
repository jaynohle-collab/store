-- Non-destructive compatibility migration for the deployed Neon PoC.
--
-- Run after 001_initial.sql. It preserves existing rows, adds fields used by
-- the maintained service, and only backfills from legacy columns when present.
-- No duplicate decisions or UNIQUE(url) constraint are introduced.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
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

-- Some early PoC versions used company_name. Copy it without deleting or
-- renaming the legacy column, so rollback remains possible.
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

UPDATE jobs SET required_skills = '[]'::jsonb WHERE required_skills IS NULL;
UPDATE jobs SET preferred_skills = '[]'::jsonb WHERE preferred_skills IS NULL;
UPDATE jobs SET created_at = NOW() WHERE created_at IS NULL;
UPDATE jobs SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'jobs'
      AND column_name = 'id'
      AND udt_name = 'uuid'
  ) THEN
    EXECUTE 'UPDATE jobs SET id = gen_random_uuid() WHERE id IS NULL';
  END IF;
END
$$;

ALTER TABLE jobs ALTER COLUMN required_skills SET DEFAULT '[]'::jsonb;
ALTER TABLE jobs ALTER COLUMN preferred_skills SET DEFAULT '[]'::jsonb;
ALTER TABLE jobs ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE jobs ALTER COLUMN updated_at SET DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_storage_id ON jobs (id);
CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs (url);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs (company);
CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs (title);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_date ON jobs (posted_date);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);
