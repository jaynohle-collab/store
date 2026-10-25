-- 013: align the gpt-fit-v2 QUALIFIED row check with the admission policy from PR #29.
-- QUALIFIED may now be US remote nationwide, US state/city-restricted remote, or US hybrid,
-- with gpt_relevance_score >= 60. This only loosens the check; no rows are changed or removed.
BEGIN;

ALTER TABLE discovery_gpt_evaluations
  DROP CONSTRAINT IF EXISTS discovery_gpt_evaluations_gpt_fit_v2_qualified_check;

ALTER TABLE discovery_gpt_evaluations
  ADD CONSTRAINT discovery_gpt_evaluations_gpt_fit_v2_qualified_check
  CHECK (
    NOT (
      evaluation_version = 'gpt-fit-v2'
      AND gpt_decision = 'QUALIFIED'
    )
    OR (
      remote_scope IN ('US_NATIONWIDE', 'US_RESTRICTED', 'HYBRID')
      AND direct_posting_url_verified IS TRUE
      AND posting_status = 'OPEN'
      AND posting_status_verified_at IS NOT NULL
      AND description_hash ~ '^[a-f0-9]{16}$'
      AND normalization_version IS NOT NULL
      AND btrim(normalization_version) <> ''
      AND gpt_relevance_score >= 60
    )
  );

COMMIT;
