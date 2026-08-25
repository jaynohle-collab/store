-- Additive discovery-batch provenance, processing attempts, and audited revert.
-- Safe to re-run. Does not modify or delete existing job / application /
-- evaluation / audit rows. Historical batches without effect rows remain
-- non-revertible by design (preview returns revertible=false).
--
-- Production order (do not run from this PR automatically):
--   1) Apply 008 (if not already)
--   2) Apply this 009
--   3) Deploy MCP + Python worker that uses jobs:worker + atomic apply
--   4) Grant Auth0 permissions: jobs:worker (M2M), jobs:revert (ChatGPT / operators)
--   5) Enable GitHub Actions process-discovery-inbox workflow
--   6) Refresh ChatGPT MCP connector (must NOT include jobs:worker or jobs:delete)

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Allow terminal status "reverted" on inbox batches (additive CHECK replacement).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discovery_inbox_batches_status_check'
  ) THEN
    ALTER TABLE discovery_inbox_batches
      DROP CONSTRAINT discovery_inbox_batches_status_check;
  END IF;
END $$;

ALTER TABLE discovery_inbox_batches
  ADD CONSTRAINT discovery_inbox_batches_status_check
  CHECK (
    status IN (
      'pending',
      'processing',
      'completed',
      'failed',
      'reverted'
    )
  );

-- Durable processing attempts (one active attempt per batch).
CREATE TABLE IF NOT EXISTS discovery_batch_processing_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES discovery_inbox_batches (id),
  status TEXT NOT NULL,
  worker_identity TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mutation_started BOOLEAN NOT NULL DEFAULT FALSE,
  sanitized_error TEXT,
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_batch_processing_attempts_status_check
    CHECK (
      status IN (
        'claimed',
        'completed',
        'failed',
        'abandoned'
      )
    ),
  CONSTRAINT discovery_batch_processing_attempts_worker_identity_check
    CHECK (btrim(worker_identity) <> '')
);

-- At most one active (claimed) attempt per batch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_batch_active_attempt
  ON discovery_batch_processing_attempts (batch_id)
  WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_discovery_batch_attempts_batch_status
  ON discovery_batch_processing_attempts (batch_id, status, claimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_attempts_heartbeat
  ON discovery_batch_processing_attempts (heartbeat_at ASC)
  WHERE status = 'claimed';

-- Link inbox rows to the current attempt (nullable for legacy rows).
ALTER TABLE discovery_inbox_batches
  ADD COLUMN IF NOT EXISTS active_attempt_id UUID
  REFERENCES discovery_batch_processing_attempts (id);

-- Per input-job effects created/updated by a processed inbox batch.
CREATE TABLE IF NOT EXISTS discovery_batch_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES discovery_inbox_batches (id),
  attempt_id UUID NOT NULL REFERENCES discovery_batch_processing_attempts (id),
  input_index INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  client_candidate_id TEXT,
  company TEXT,
  title TEXT,
  source TEXT,
  external_job_id TEXT,
  normalized_url TEXT,
  canonical_job_id UUID REFERENCES canonical_jobs (id),
  posting_id UUID REFERENCES job_postings (id),
  processing_action TEXT NOT NULL,
  created_canonical BOOLEAN NOT NULL DEFAULT FALSE,
  created_posting BOOLEAN NOT NULL DEFAULT FALSE,
  before_state JSONB,
  after_state JSONB,
  before_fingerprint TEXT,
  after_fingerprint TEXT,
  evaluation_id UUID,
  evaluation_posting_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_batch_effects_action_check
    CHECK (
      processing_action IN (
        'created',
        'updated',
        'reposted',
        'unchanged',
        'skipped'
      )
    ),
  CONSTRAINT discovery_batch_effects_input_index_check
    CHECK (input_index >= 0),
  CONSTRAINT discovery_batch_effects_batch_input_unique
    UNIQUE (batch_id, input_index),
  CONSTRAINT discovery_batch_effects_idempotency_unique
    UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_effects_batch_id
  ON discovery_batch_effects (batch_id);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_effects_attempt_id
  ON discovery_batch_effects (attempt_id);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_effects_posting_id
  ON discovery_batch_effects (posting_id)
  WHERE posting_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_batch_effects_canonical_job_id
  ON discovery_batch_effects (canonical_job_id)
  WHERE canonical_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_batch_effects_normalized_url
  ON discovery_batch_effects (normalized_url)
  WHERE normalized_url IS NOT NULL;

-- Append-only revert audit trail (never updated/deleted by revert tools).
-- idempotency_key is the successful preview_hash (full SHA-256 hex).
CREATE TABLE IF NOT EXISTS discovery_batch_revert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES discovery_inbox_batches (id),
  preview_hash TEXT NOT NULL,
  requested_by TEXT,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  compensated_effect_ids UUID[] NOT NULL DEFAULT '{}',
  protected_effect_ids UUID[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_batch_revert_events_batch_idempotency_unique
    UNIQUE (batch_id, idempotency_key),
  CONSTRAINT discovery_batch_revert_events_preview_hash_format
    CHECK (preview_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT discovery_batch_revert_events_idempotency_matches_preview
    CHECK (idempotency_key = preview_hash)
);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_revert_events_batch_id
  ON discovery_batch_revert_events (batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_batch_revert_events_preview_hash
  ON discovery_batch_revert_events (preview_hash);

COMMIT;
