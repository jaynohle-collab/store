-- Milestone 5: company registry, adaptive scan leases, automatic discovery runs,
-- and storage observability helpers. Additive / idempotent only.
-- Does not alter inbox, lifecycle, GPT evaluations, or provenance contracts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS discovery_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_key TEXT NOT NULL,
  company_name TEXT NOT NULL,
  careers_url TEXT,
  ats_provider TEXT NOT NULL,
  ats_org_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scan_priority TEXT NOT NULL DEFAULT 'normal',
  last_attempted_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_until TIMESTAMPTZ,
  last_error_category TEXT,
  last_error_summary TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_run_id UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_companies_company_key_unique UNIQUE (company_key),
  CONSTRAINT discovery_companies_ats_provider_check CHECK (
    ats_provider IN (
      'greenhouse',
      'ashby',
      'lever',
      'workday',
      'company_careers',
      'workable',
      'smartrecruiters',
      'teamtailor',
      'recruitee',
      'bamboohr',
      'jobvite',
      'icims',
      'personio',
      'rippling',
      'comeet',
      'pinpoint',
      'other'
    )
  ),
  CONSTRAINT discovery_companies_scan_priority_check CHECK (
    scan_priority IN (
      'manual',
      'hot',
      'high',
      'normal',
      'inactive'
    )
  ),
  CONSTRAINT discovery_companies_failures_nonneg CHECK (consecutive_failures >= 0),
  CONSTRAINT discovery_companies_ats_org_when_required CHECK (
    ats_provider = 'company_careers'
    OR ats_provider = 'other'
    OR (ats_org_id IS NOT NULL AND length(trim(ats_org_id)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS discovery_company_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES discovery_companies (id),
  status TEXT NOT NULL,
  worker_identity TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_category TEXT,
  error_summary TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_company_runs_status_check CHECK (
    status IN ('claimed', 'completed', 'failed', 'expired')
  )
);

ALTER TABLE discovery_companies
  DROP CONSTRAINT IF EXISTS discovery_companies_active_run_fkey;
ALTER TABLE discovery_companies
  ADD CONSTRAINT discovery_companies_active_run_fkey
  FOREIGN KEY (active_run_id) REFERENCES discovery_company_runs (id);

CREATE TABLE IF NOT EXISTS automatic_discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  worker_identity TEXT,
  llm_provider TEXT,
  error_summary TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automatic_discovery_runs_status_check CHECK (
    status IN ('running', 'completed', 'failed', 'partial')
  )
);

CREATE INDEX IF NOT EXISTS idx_discovery_companies_due
  ON discovery_companies (enabled, next_eligible_at, scan_priority)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_discovery_companies_provider
  ON discovery_companies (ats_provider, enabled);

CREATE INDEX IF NOT EXISTS idx_discovery_companies_active_lease
  ON discovery_companies (active_run_id, lease_expires_at)
  WHERE active_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_company_runs_status_started
  ON discovery_company_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_automatic_discovery_runs_started
  ON automatic_discovery_runs (started_at DESC);

-- At most one claimed lease per company.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_company_runs_one_claimed_per_company
  ON discovery_company_runs (company_id)
  WHERE status = 'claimed';

-- Seed starter companies DISABLED by default so enabling the schedule cannot
-- unexpectedly fan out scans across large ATS boards. Operators must explicitly
-- enable each company (or use force_scan_now) before production scanning.
INSERT INTO discovery_companies (
  company_key, company_name, careers_url, ats_provider, ats_org_id, scan_priority, enabled
)
VALUES
  ('stripe', 'Stripe', 'https://boards.greenhouse.io/stripe', 'greenhouse', 'stripe', 'high', FALSE),
  ('notion', 'Notion', 'https://jobs.ashbyhq.com/notion', 'ashby', 'notion', 'high', FALSE),
  ('netflix', 'Netflix', 'https://jobs.lever.co/netflix', 'lever', 'netflix', 'normal', FALSE),
  ('figma', 'Figma', 'https://jobs.ashbyhq.com/figma', 'ashby', 'figma', 'hot', FALSE),
  ('airbnb', 'Airbnb', 'https://boards.greenhouse.io/airbnb', 'greenhouse', 'airbnb', 'normal', FALSE),
  ('datadog', 'Datadog', 'https://boards.greenhouse.io/datadog', 'greenhouse', 'datadog', 'normal', FALSE),
  ('cloudflare', 'Cloudflare', 'https://boards.greenhouse.io/cloudflare', 'greenhouse', 'cloudflare', 'normal', FALSE),
  ('ramp', 'Ramp', 'https://jobs.ashbyhq.com/ramp', 'ashby', 'ramp', 'hot', FALSE),
  ('openai', 'OpenAI', 'https://jobs.ashbyhq.com/openai', 'ashby', 'openai', 'high', FALSE),
  ('shopify', 'Shopify', 'https://www.shopify.com/careers', 'company_careers', NULL, 'inactive', FALSE)
ON CONFLICT (company_key) DO NOTHING;

COMMIT;
