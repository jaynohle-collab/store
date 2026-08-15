-- Jay Job MCP initial schema
-- Safe for existing Neon deployments: uses IF NOT EXISTS throughout.
-- Does NOT add UNIQUE(url); duplicate decisions belong to the Python job agent.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  source TEXT,
  description TEXT,
  required_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  remote_status TEXT,
  salary TEXT,
  posted_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs (url);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs (company);
CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs (title);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_date ON jobs (posted_date);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);

-- Compatibility: if an older PoC table exists without newer columns, add them safely.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_skills JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS preferred_skills JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS remote_status TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS posted_date TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
