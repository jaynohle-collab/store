-- Fixture: legacy TEXT id containing only valid UUID strings.
-- Migration must convert with USING and preserve the exact IDs.
DROP TABLE IF EXISTS jobs;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_date TEXT,
  created_at TEXT,
  updated_at TEXT,
  required_skills TEXT,
  preferred_skills TEXT
);

INSERT INTO jobs (id, company, title, url, posted_date, created_at, updated_at, required_skills, preferred_skills)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'Acme',
    'Engineer',
    'https://example.com/text-valid-1',
    '2026-08-01T12:00:00Z',
    '2026-08-01T12:00:00Z',
    '2026-08-01T12:00:00Z',
    '[]',
    '[]'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'Beta',
    'Analyst',
    'https://example.com/text-valid-2',
    '2026-08-02',
    '2026-08-02T08:00:00+00:00',
    '2026-08-02T08:00:00+00:00',
    '["python"]',
    '["sql"]'
  );
