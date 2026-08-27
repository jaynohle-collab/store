-- Milestone 5 follow-up: durable pending evaluation queue.
-- Preserves candidates that passed deterministic/preflight gates but could not
-- be LLM-evaluated (provider quota / rate-limit / all providers down).
-- Additive / idempotent. Does not alter GPT evaluation or inbox contracts.

BEGIN;

CREATE TABLE IF NOT EXISTS discovery_pending_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL,
  company_id UUID REFERENCES discovery_companies (id) ON DELETE SET NULL,
  company_key TEXT,
  client_candidate_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  external_job_id TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  posted_date TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  description_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_pending_evaluations_fingerprint_unique UNIQUE (fingerprint),
  CONSTRAINT discovery_pending_evaluations_status_check CHECK (
    status IN ('pending', 'in_progress', 'completed', 'abandoned')
  ),
  CONSTRAINT discovery_pending_evaluations_hash_check CHECK (
    description_hash ~ '^[a-f0-9]{16}$'
  ),
  CONSTRAINT discovery_pending_evaluations_description_nonempty CHECK (
    length(trim(description)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_discovery_pending_evaluations_status_created
  ON discovery_pending_evaluations (status, created_at ASC)
  WHERE status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_discovery_pending_evaluations_company_key
  ON discovery_pending_evaluations (company_key, status);

COMMIT;
