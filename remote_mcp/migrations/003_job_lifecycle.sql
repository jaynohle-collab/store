-- Job lifecycle model: canonical jobs, postings, applications, discovery runs.
-- Additive only. Does NOT drop or mutate the legacy `jobs` PoC table.
--
-- Atomic: entire migration is one transaction.
--
-- Backfill strategy (manual / future, NOT automatic):
--   1. For each legacy jobs row, INSERT into canonical_jobs using
--      company / company_key / title / normalized_title derived in Python.
--   2. INSERT a job_postings row linked to that canonical_job_id, copying
--      url, source, description, description_hash, location, salary,
--      posted_date; set first_seen_at/last_seen_at from created_at/updated_at.
--   3. Do NOT invent external_job_id, applications, or is_repost flags.
--   4. Keep legacy jobs rows until a separate cutover decision.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- canonical_jobs: logical role / job identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  location TEXT,
  normalized_location TEXT,
  role_family TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_jobs_company_key
  ON canonical_jobs (company_key);
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_normalized_title
  ON canonical_jobs (normalized_title);
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_company_title
  ON canonical_jobs (company_key, normalized_title);
CREATE INDEX IF NOT EXISTS idx_canonical_jobs_last_seen_at
  ON canonical_jobs (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- job_postings: each discovered posting occurrence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs (id),
  source TEXT,
  external_job_id TEXT,
  url TEXT,
  normalized_url TEXT,
  description TEXT,
  description_hash TEXT,
  location TEXT,
  remote_status TEXT,
  salary TEXT,
  posted_date TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posting_status TEXT NOT NULL DEFAULT 'active',
  is_repost BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes_posting_id UUID REFERENCES job_postings (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_postings_canonical_job_id
  ON job_postings (canonical_job_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_normalized_url
  ON job_postings (normalized_url);
CREATE INDEX IF NOT EXISTS idx_job_postings_source_external_id
  ON job_postings (source, external_job_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_posted_date
  ON job_postings (posted_date);
CREATE INDEX IF NOT EXISTS idx_job_postings_last_seen_at
  ON job_postings (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_postings_is_repost
  ON job_postings (is_repost);

-- Supports composite FK from applications(posting_id, canonical_job_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_id_canonical_job_id
  ON job_postings (id, canonical_job_id);

-- URL is intentionally NOT globally unique (reposts / mirrors allowed).
-- Source-scoped external IDs are unique when present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_source_external_id
  ON job_postings (source, external_job_id)
  WHERE external_job_id IS NOT NULL AND source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- applications: application attached to a specific posting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs (id),
  posting_id UUID NOT NULL REFERENCES job_postings (id),
  applied_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'planned',
  application_url TEXT,
  resume_version TEXT,
  cover_letter_version TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Prevent applications from referencing a posting under the wrong canonical job.
  CONSTRAINT fk_applications_posting_canonical
    FOREIGN KEY (posting_id, canonical_job_id)
    REFERENCES job_postings (id, canonical_job_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_canonical_job_id
  ON applications (canonical_job_id);
-- One application per posting occurrence (reposts use a new posting_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_posting_id
  ON applications (posting_id);
CREATE INDEX IF NOT EXISTS idx_applications_status
  ON applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_applied_at
  ON applications (applied_at DESC);

-- ---------------------------------------------------------------------------
-- application_events: immutable-ish application timeline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications (id),
  event_type TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_events_application_id
  ON application_events (application_id);
CREATE INDEX IF NOT EXISTS idx_application_events_event_at
  ON application_events (event_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_events_event_type
  ON application_events (event_type);

-- ---------------------------------------------------------------------------
-- discovery_runs: one row per discovery execution
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  jobs_discovered INTEGER NOT NULL DEFAULT 0,
  new_jobs INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_started_at
  ON discovery_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_source
  ON discovery_runs (source);

-- Explicit note: legacy `jobs` table is intentionally preserved.

COMMIT;
