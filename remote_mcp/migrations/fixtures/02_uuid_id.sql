-- Fixture: existing PoC with UUID id values that must be preserved.
DROP TABLE IF EXISTS jobs;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO jobs (id, company, title, url)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Acme', 'Engineer', 'https://example.com/uuid-a'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Beta', 'Analyst', 'https://example.com/uuid-b');
