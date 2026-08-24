-- Additive gpt-fit-v2 discovery evaluation evidence fields.
-- Does not modify or delete existing evaluation rows.
-- New columns are nullable so gpt-fit-v1 history remains valid.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS and guarded ADD CONSTRAINT.

BEGIN;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS remote_scope TEXT;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS direct_posting_url_verified BOOLEAN;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS normalization_version TEXT;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS posting_status TEXT;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS posting_status_verified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discovery_gpt_evaluations_remote_scope_check'
  ) THEN
    ALTER TABLE discovery_gpt_evaluations
      ADD CONSTRAINT discovery_gpt_evaluations_remote_scope_check
      CHECK (
        remote_scope IS NULL
        OR remote_scope IN (
          'US_NATIONWIDE',
          'US_RESTRICTED',
          'HYBRID',
          'ONSITE',
          'NON_US',
          'UNKNOWN'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discovery_gpt_evaluations_posting_status_check'
  ) THEN
    ALTER TABLE discovery_gpt_evaluations
      ADD CONSTRAINT discovery_gpt_evaluations_posting_status_check
      CHECK (
        posting_status IS NULL
        OR posting_status IN ('OPEN', 'CLOSED', 'UNKNOWN')
      );
  END IF;
END $$;

-- Structural integrity for gpt-fit-v2 QUALIFIED rows only. v1 rows are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discovery_gpt_evaluations_gpt_fit_v2_qualified_check'
  ) THEN
    ALTER TABLE discovery_gpt_evaluations
      ADD CONSTRAINT discovery_gpt_evaluations_gpt_fit_v2_qualified_check
      CHECK (
        NOT (
          evaluation_version = 'gpt-fit-v2'
          AND gpt_decision = 'QUALIFIED'
        )
        OR (
          remote_scope = 'US_NATIONWIDE'
          AND direct_posting_url_verified IS TRUE
          AND posting_status = 'OPEN'
          AND posting_status_verified_at IS NOT NULL
          AND description_hash ~ '^[a-f0-9]{16}$'
          AND normalization_version IS NOT NULL
          AND btrim(normalization_version) <> ''
          AND gpt_relevance_score >= 70
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_remote_scope
  ON discovery_gpt_evaluations (remote_scope, evaluation_version, created_at DESC, id DESC)
  WHERE remote_scope IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_direct_url
  ON discovery_gpt_evaluations (direct_posting_url_verified, evaluation_version, created_at DESC)
  WHERE direct_posting_url_verified IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_posting_status
  ON discovery_gpt_evaluations (posting_status, evaluation_version, created_at DESC)
  WHERE posting_status IS NOT NULL;

COMMIT;
