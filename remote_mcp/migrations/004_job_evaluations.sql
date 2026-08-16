-- Job evaluations: persisted candidate-match outputs (Python-owned).
-- Additive only. Does not alter lifecycle tables or history.
--
-- match_score is NOT intrinsic job truth — it is an evaluation snapshot
-- keyed to scoring_version / profile_version.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS job_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id UUID NOT NULL REFERENCES job_postings (id),
  match_score NUMERIC,
  recommendation TEXT,
  reason TEXT,
  scoring_version TEXT,
  profile_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_evaluations_posting_id
  ON job_evaluations (posting_id);
CREATE INDEX IF NOT EXISTS idx_job_evaluations_evaluated_at
  ON job_evaluations (evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_evaluations_match_score
  ON job_evaluations (match_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_job_evaluations_recommendation
  ON job_evaluations (recommendation);

-- Latest evaluation per posting (for dashboard queries).
CREATE INDEX IF NOT EXISTS idx_job_evaluations_posting_evaluated
  ON job_evaluations (posting_id, evaluated_at DESC, created_at DESC);

COMMIT;
