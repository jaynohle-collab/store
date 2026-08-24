-- GPT discovery admission evaluations (gpt-fit-v1).
-- Additive only. Separate from Python profile-v1 job_evaluations.
--
-- GPT evaluates semantic relevance; MCP stores evaluation evidence.
-- History is retained (append-only) by version and description hash.
-- Latest lookups use server created_at (never client evaluated_at).
-- client_evaluation_id enables idempotent retries.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS discovery_gpt_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_evaluation_id UUID NOT NULL,
  client_candidate_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT,
  source TEXT NOT NULL,
  external_job_id TEXT,
  location TEXT,
  description_hash TEXT,
  gpt_relevance_score INTEGER NOT NULL,
  gpt_decision TEXT NOT NULL,
  hard_rejection_reason TEXT,
  reasoning_summary TEXT NOT NULL,
  evaluation_version TEXT NOT NULL,
  -- Client-supplied evidence timestamp only; never used for "latest" ordering.
  evaluated_at TIMESTAMPTZ,
  -- Server-recorded insert time; authoritative for latest selection.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_gpt_evaluations_decision_check
    CHECK (gpt_decision IN ('QUALIFIED', 'REJECTED_LOW_SCORE', 'REJECTED_HARD_RULE')),
  CONSTRAINT discovery_gpt_evaluations_score_check
    CHECK (gpt_relevance_score >= 0 AND gpt_relevance_score <= 100),
  CONSTRAINT discovery_gpt_evaluations_reasoning_len_check
    CHECK (char_length(reasoning_summary) <= 1000),
  CONSTRAINT discovery_gpt_evaluations_client_evaluation_id_key
    UNIQUE (client_evaluation_id)
);

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_normalized_url
  ON discovery_gpt_evaluations (normalized_url, evaluation_version, created_at DESC, id DESC)
  WHERE normalized_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_source_external
  ON discovery_gpt_evaluations (source, external_job_id, evaluation_version, created_at DESC, id DESC)
  WHERE external_job_id IS NOT NULL AND external_job_id <> '';

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_client_candidate
  ON discovery_gpt_evaluations (client_candidate_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_hash_version
  ON discovery_gpt_evaluations (description_hash, evaluation_version, created_at DESC, id DESC)
  WHERE description_hash IS NOT NULL AND description_hash <> '';

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_created_at
  ON discovery_gpt_evaluations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_evaluation_version
  ON discovery_gpt_evaluations (evaluation_version, created_at DESC, id DESC);

COMMIT;
