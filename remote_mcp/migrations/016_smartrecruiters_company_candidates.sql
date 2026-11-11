-- Expand automatic company discovery to SmartRecruiters.
-- Reapplicable and transactional; preserves all candidate state and preferences.
BEGIN;

ALTER TABLE discovery_company_candidates
  DROP CONSTRAINT IF EXISTS discovery_company_candidates_provider_check;

ALTER TABLE discovery_company_candidates
  ADD CONSTRAINT discovery_company_candidates_provider_check CHECK (
    ats_provider IN ('greenhouse', 'ashby', 'lever', 'workday', 'company_careers', 'smartrecruiters')
  );

COMMIT;
