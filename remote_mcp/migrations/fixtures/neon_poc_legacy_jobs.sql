-- Fixture: live Neon PoC legacy jobs shape that previously broke migration 002.
-- Not applied to production. Used by regression tests / local dry-runs only.
--
-- Critical failure mode:
--   posted_date TEXT NOT NULL DEFAULT ''
-- PostgreSQL rejects ALTER ... TYPE TIMESTAMPTZ while that text default remains.

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
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

INSERT INTO jobs (
  id, company, title, url, location, source, description, description_hash,
  required_skills, preferred_skills, remote_status, salary,
  posted_date, created_at, updated_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Acme',
  'Engineer',
  'https://example.com/jobs/1',
  'Remote',
  'greenhouse',
  'Build things',
  'abc123',
  '[]',
  '[]',
  'remote',
  '',
  '2026-08-12',
  '2026-08-12T00:00:00Z',
  '2026-08-12T00:00:00Z'
);

INSERT INTO jobs (
  id, company, title, url, location, source, description, description_hash,
  required_skills, preferred_skills, remote_status, salary,
  posted_date, created_at, updated_at
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  'Beta',
  'Analyst',
  'https://example.com/jobs/2',
  '',
  '',
  '',
  '',
  '[]',
  '[]',
  '',
  '',
  '',
  '2026-08-13T00:00:00Z',
  '2026-08-13T00:00:00Z'
);
