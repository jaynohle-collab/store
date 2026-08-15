-- Fixture: brand-new jobs table already matching the maintained schema.
DROP TABLE IF EXISTS jobs;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  source TEXT,
  description TEXT,
  description_hash TEXT,
  required_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  remote_status TEXT,
  salary TEXT,
  posted_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO jobs (company, title, url, description_hash)
VALUES ('Acme', 'Engineer', 'https://example.com/a', 'hash-a');
