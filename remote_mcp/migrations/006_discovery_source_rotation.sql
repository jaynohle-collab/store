-- Discovery source rotation cursor and claimable runs.
-- Additive only. Does not alter inbox, lifecycle, or evaluation tables.
--
-- discovery_sources = configured ordered sources (enabled catalog).
-- discovery_rotation_state = singleton cursor (cycle + current source + active claim + failure counts).
-- discovery_source_runs = claim/complete/fail/skip history with counters and checkpoint.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS discovery_sources (
  source_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_order INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_sources_order_unique UNIQUE (source_order),
  CONSTRAINT discovery_sources_order_positive CHECK (source_order > 0)
);

CREATE TABLE IF NOT EXISTS discovery_source_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id INTEGER NOT NULL,
  source_key TEXT NOT NULL REFERENCES discovery_sources (source_key),
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  preflight_skipped_count INTEGER NOT NULL DEFAULT 0,
  evaluated_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  submitted_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_source_runs_status_check
    CHECK (status IN ('claimed', 'completed', 'failed', 'skipped_after_failures')),
  CONSTRAINT discovery_source_runs_attempt_positive CHECK (attempt_number > 0),
  CONSTRAINT discovery_source_runs_counts_nonneg CHECK (
    discovered_count >= 0
    AND preflight_skipped_count >= 0
    AND evaluated_count >= 0
    AND qualified_count >= 0
    AND submitted_count >= 0
  ),
  CONSTRAINT discovery_source_runs_counts_chain CHECK (
    preflight_skipped_count <= discovered_count
    AND evaluated_count <= discovered_count
    AND qualified_count <= evaluated_count
    AND submitted_count <= qualified_count
  )
);

CREATE TABLE IF NOT EXISTS discovery_rotation_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  cycle_id INTEGER NOT NULL DEFAULT 1,
  current_source_key TEXT NOT NULL REFERENCES discovery_sources (source_key),
  active_run_id UUID REFERENCES discovery_source_runs (id),
  source_failure_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_rotation_state_singleton CHECK (id = 1),
  CONSTRAINT discovery_rotation_state_cycle_positive CHECK (cycle_id > 0)
);

CREATE INDEX IF NOT EXISTS idx_discovery_sources_enabled_order
  ON discovery_sources (enabled, source_order);

CREATE INDEX IF NOT EXISTS idx_discovery_source_runs_status_started
  ON discovery_source_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_source_runs_cycle_source
  ON discovery_source_runs (cycle_id, source_key);

-- At most one globally active claimed run (concurrent claim protection).
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_source_runs_one_claimed
  ON discovery_source_runs ((1))
  WHERE status = 'claimed';

INSERT INTO discovery_sources (source_key, display_name, source_order, enabled)
VALUES
  ('ashby', 'Ashby', 1, TRUE),
  ('greenhouse', 'Greenhouse', 2, TRUE),
  ('lever', 'Lever', 3, TRUE),
  ('workday', 'Workday', 4, TRUE),
  ('company_careers', 'Company careers pages', 5, TRUE)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO discovery_rotation_state (
  id, cycle_id, current_source_key, active_run_id, source_failure_counts
)
VALUES (1, 1, 'ashby', NULL, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

COMMIT;
