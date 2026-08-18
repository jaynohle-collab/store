-- Raw ChatGPT discovery inbox (unprocessed input).
-- Additive only. Does not replace discovery_runs.
--
-- discovery_runs = processed lifecycle-run summaries (Python-owned).
-- discovery_inbox_batches = unprocessed raw discovery JSON from ChatGPT.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS discovery_inbox_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  job_count INTEGER NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_inbox_batches_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT discovery_inbox_batches_job_count_check
    CHECK (job_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_discovery_inbox_batches_status
  ON discovery_inbox_batches (status);

CREATE INDEX IF NOT EXISTS idx_discovery_inbox_batches_pending_submitted
  ON discovery_inbox_batches (submitted_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_discovery_inbox_batches_source
  ON discovery_inbox_batches (source);

COMMIT;
