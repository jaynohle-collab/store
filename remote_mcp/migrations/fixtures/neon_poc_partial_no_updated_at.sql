-- Fixture: partial Neon PoC jobs table where updated_at is absent.
-- Not applied to production. Used by regression tests / local dry-runs only.
--
-- Live temporary-branch finding:
--   002 ADDs updated_at TIMESTAMPTZ DEFAULT NOW() as nullable
--   and previously never enforced NOT NULL afterward.
-- After repair + SET NOT NULL, updated_at must match 001_initial.sql.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  description_hash TEXT NOT NULL DEFAULT '',
  required_skills TEXT NOT NULL DEFAULT '[]',
  preferred_skills TEXT NOT NULL DEFAULT '[]',
  remote_status TEXT NOT NULL DEFAULT '',
  salary TEXT NOT NULL DEFAULT '',
  posted_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);

INSERT INTO jobs (
  id, company, title, url, location, source, description, description_hash,
  required_skills, preferred_skills, remote_status, salary,
  posted_date, created_at
) VALUES (
  '33333333-3333-4333-8333-333333333333',
  'Gamma',
  'Platform Engineer',
  'https://example.com/jobs/3',
  'SF',
  'lever',
  'Ship platforms',
  'def456',
  '[]',
  '[]',
  'hybrid',
  '',
  '2026-08-12',
  '2026-08-12T00:00:00Z'
);
