-- Fixture: legacy TEXT id with at least one invalid UUID.
-- Migration MUST abort and leave this data untouched.
DROP TABLE IF EXISTS jobs;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL
);

INSERT INTO jobs (id, company, title, url)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Acme', 'Engineer', 'https://example.com/ok'),
  ('not-a-uuid', 'Broken', 'Legacy', 'https://example.com/bad');
