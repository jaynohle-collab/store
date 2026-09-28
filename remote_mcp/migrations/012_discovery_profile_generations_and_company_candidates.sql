-- Milestone 6: single-persona discovery platform.
--   * Profile identity on GPT evaluation evidence (profile-specific generations).
--   * Company candidate registry for automatic, verified company expansion.
-- Additive / idempotent only. No backfill, no deletes, no rewrites of history.
-- Rows with NULL profile_id/profile_version are legacy evidence produced for the
-- original single persona (jay / jay-ai-v1) before profile identity existed.

BEGIN;

ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS profile_id TEXT;
ALTER TABLE discovery_gpt_evaluations
  ADD COLUMN IF NOT EXISTS profile_version TEXT;

CREATE INDEX IF NOT EXISTS idx_discovery_gpt_evaluations_profile_generation
  ON discovery_gpt_evaluations (
    profile_id, profile_version, evaluation_version, created_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS discovery_company_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_key TEXT NOT NULL,
  company_name TEXT NOT NULL,
  ats_provider TEXT NOT NULL,
  ats_org_id TEXT,
  careers_url TEXT,
  -- Where the candidate came from (seed_catalog, posting_history, ...).
  discovery_source TEXT NOT NULL,
  source_ref TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  next_verification_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  last_error_category TEXT,
  last_error_summary TEXT,
  verified_job_count INTEGER,
  suggested_priority TEXT NOT NULL DEFAULT 'normal',
  promoted_company_id UUID REFERENCES discovery_companies (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_company_candidates_company_key_unique UNIQUE (company_key),
  CONSTRAINT discovery_company_candidates_status_check CHECK (
    verification_status IN ('pending', 'verifying', 'verified', 'failed', 'rejected')
  ),
  CONSTRAINT discovery_company_candidates_provider_check CHECK (
    ats_provider IN ('greenhouse', 'ashby', 'lever', 'workday', 'company_careers')
  ),
  CONSTRAINT discovery_company_candidates_priority_check CHECK (
    suggested_priority IN ('high', 'normal', 'inactive')
  ),
  CONSTRAINT discovery_company_candidates_attempts_nonneg CHECK (
    verification_attempts >= 0
  ),
  CONSTRAINT discovery_company_candidates_org_when_required CHECK (
    ats_provider = 'company_careers'
    OR (ats_org_id IS NOT NULL AND length(trim(ats_org_id)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_company_candidates_provider_org
  ON discovery_company_candidates (ats_provider, lower(ats_org_id))
  WHERE ats_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_company_candidates_due
  ON discovery_company_candidates (verification_status, next_verification_at)
  WHERE verification_status IN ('pending', 'failed', 'verifying');

-- Enabled registry must not hold the same ATS org twice. Guarded so the
-- migration never fails on pre-existing duplicates (resolved by operators).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM discovery_companies
    WHERE ats_org_id IS NOT NULL
    GROUP BY ats_provider, lower(ats_org_id)
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_companies_provider_org
      ON discovery_companies (ats_provider, lower(ats_org_id))
      WHERE ats_org_id IS NOT NULL;
  END IF;
END $$;

COMMIT;
