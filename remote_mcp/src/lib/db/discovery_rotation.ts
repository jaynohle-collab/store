/**
 * Discovery source rotation persistence.
 * Claim/complete/fail are transaction-safe and do not crawl, score, or save jobs.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getSql } from "./client";
import {
  advanceDiscoveryCursor,
  assertCheckpointSize,
  assertCounterChain,
  clearFailureCounts,
  DEFAULT_DISCOVERY_SOURCES,
  getClaimTimeoutMs,
  getMaxAttempts,
  incrementFailureCount,
  isClaimStale,
  listEnabledSourcesOrdered,
  parseFailureCounts,
  resetFailureCountForSource,
  sanitizeDiscoveryError,
  shouldSkipAfterFailure,
  type DiscoveryRunStatus,
  type DiscoverySourceRecord,
} from "../discovery/rotation";

function mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value == null ? null : value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

export class DiscoveryRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryRotationError";
  }
}

const checkpointSchema = z.record(z.string(), z.unknown()).superRefine((checkpoint, ctx) => {
  try {
    assertCheckpointSize(checkpoint);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid checkpoint",
    });
  }
});

export const discoveryRunCountersSchema = z
  .object({
    discovered_count: z.number().int().min(0).default(0),
    preflight_skipped_count: z.number().int().min(0).default(0),
    evaluated_count: z.number().int().min(0).default(0),
    qualified_count: z.number().int().min(0).default(0),
    submitted_count: z.number().int().min(0).default(0),
  })
  .superRefine((counters, ctx) => {
    try {
      assertCounterChain(counters);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid counters",
      });
    }
  });

export const completeDiscoverySourceSchema = z
  .object({
    run_id: z.string().uuid(),
    checkpoint: checkpointSchema.optional(),
  })
  .merge(discoveryRunCountersSchema)
  .strict();

export const failDiscoverySourceSchema = z
  .object({
    run_id: z.string().uuid(),
    error: z.string().min(1).max(4000),
    checkpoint: checkpointSchema.optional(),
  })
  .strict();

export type DiscoverySourceRun = {
  id: string;
  cycle_id: number;
  source_key: string;
  status: DiscoveryRunStatus;
  attempt_number: number;
  started_at: string;
  completed_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  checkpoint: Record<string, unknown>;
  discovered_count: number;
  preflight_skipped_count: number;
  evaluated_count: number;
  qualified_count: number;
  submitted_count: number;
};

export type DiscoveryRotationSnapshot = {
  cycle_id: number;
  current_source_key: string;
  active_run_id: string | null;
  source_failure_counts: Record<string, number>;
  max_attempts: number;
  sources: DiscoverySourceRecord[];
  enabled_sources: DiscoverySourceRecord[];
  latest_run: DiscoverySourceRun | null;
};

export type ClaimDiscoverySourceResult = {
  run_id: string;
  cycle_id: number;
  source_key: string;
  display_name: string;
  attempt_number: number;
  checkpoint: Record<string, unknown>;
  started_at: string;
  recovered_stale_run_id: string | null;
  stale_source_key: string | null;
  /** True when the recovered stale run hit max attempts and was skipped. */
  stale_source_skipped: boolean;
};

export type CompleteDiscoverySourceResult = {
  run: DiscoverySourceRun;
  next_source_key: string;
  next_cycle_id: number;
  wrapped: boolean;
};

export type FailDiscoverySourceRetryResult = {
  run: DiscoverySourceRun;
  cursor_source_key: string;
  cycle_id: number;
  consecutive_failures: number;
  max_attempts: number;
  retry_required: true;
  auto_advanced: false;
};

export type FailDiscoverySourceSkipResult = {
  run: DiscoverySourceRun;
  next_source_key: string;
  next_cycle_id: number;
  wrapped: boolean;
  consecutive_failures: number;
  max_attempts: number;
  retry_required: false;
  auto_advanced: true;
};

export type FailDiscoverySourceResult =
  | FailDiscoverySourceRetryResult
  | FailDiscoverySourceSkipResult;

type MemoryState = {
  sources: DiscoverySourceRecord[];
  cycleId: number;
  currentSourceKey: string;
  activeRunId: string | null;
  sourceFailureCounts: Record<string, number>;
  runs: Map<string, DiscoverySourceRun>;
};

function cloneRun(run: DiscoverySourceRun): DiscoverySourceRun {
  return {
    ...run,
    checkpoint: { ...run.checkpoint },
  };
}

function createMemoryState(): MemoryState {
  return {
    sources: DEFAULT_DISCOVERY_SOURCES.map((s) => ({ ...s })),
    cycleId: 1,
    currentSourceKey: "ashby",
    activeRunId: null,
    sourceFailureCounts: {},
    runs: new Map(),
  };
}

let memoryState: MemoryState | null = null;
let useMemoryBackend = false;

export function useInMemoryDiscoveryRotation(): void {
  useMemoryBackend = true;
  memoryState = createMemoryState();
}

export function resetInMemoryDiscoveryRotation(): void {
  memoryState = createMemoryState();
}

export function setMemorySourceEnabled(sourceKey: string, enabled: boolean): void {
  const state = requireMemory();
  const source = state.sources.find((s) => s.source_key === sourceKey);
  if (!source) throw new DiscoveryRotationError(`Unknown source: ${sourceKey}`);
  source.enabled = enabled;
  if (!enabled && state.currentSourceKey === sourceKey && !state.activeRunId) {
    const enabledSources = listEnabledSourcesOrdered(state.sources);
    if (enabledSources.length) state.currentSourceKey = enabledSources[0].source_key;
  }
}

export function backdateActiveClaimStartedAt(isoTimestamp: string): void {
  const state = requireMemory();
  if (!state.activeRunId) throw new DiscoveryRotationError("No active claim to backdate");
  const run = state.runs.get(state.activeRunId);
  if (!run) throw new DiscoveryRotationError("Active claim missing");
  run.started_at = isoTimestamp;
}

export function getMemorySourceFailureCount(sourceKey: string): number {
  return requireMemory().sourceFailureCounts[sourceKey] ?? 0;
}

/** Test helper: inspect a run in the in-memory backend. */
export function getMemoryRun(runId: string): DiscoverySourceRun | null {
  const run = requireMemory().runs.get(runId);
  return run ? cloneRun(run) : null;
}

function requireMemory(): MemoryState {
  if (!memoryState) memoryState = createMemoryState();
  return memoryState;
}

function parseCheckpoint(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mapRun(row: Record<string, unknown>): DiscoverySourceRun {
  const mapped = mapRow<Record<string, unknown>>(row);
  return {
    id: String(mapped.id),
    cycle_id: Number(mapped.cycle_id),
    source_key: String(mapped.source_key),
    status: mapped.status as DiscoveryRunStatus,
    attempt_number: Number(mapped.attempt_number ?? 1),
    started_at: String(mapped.started_at),
    completed_at: mapped.completed_at == null ? null : String(mapped.completed_at),
    last_success_at: mapped.last_success_at == null ? null : String(mapped.last_success_at),
    last_error: mapped.last_error == null ? null : String(mapped.last_error),
    checkpoint: parseCheckpoint(mapped.checkpoint),
    discovered_count: Number(mapped.discovered_count ?? 0),
    preflight_skipped_count: Number(mapped.preflight_skipped_count ?? 0),
    evaluated_count: Number(mapped.evaluated_count ?? 0),
    qualified_count: Number(mapped.qualified_count ?? 0),
    submitted_count: Number(mapped.submitted_count ?? 0),
  };
}

function latestRunFromMemory(state: MemoryState): DiscoverySourceRun | null {
  if (state.activeRunId) {
    const active = state.runs.get(state.activeRunId);
    return active ? cloneRun(active) : null;
  }
  const all = [...state.runs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  return all[0] ? cloneRun(all[0]) : null;
}

function resolveCurrentSourceKey(state: MemoryState): void {
  const enabled = listEnabledSourcesOrdered(state.sources);
  if (!enabled.length) {
    throw new DiscoveryRotationError("No enabled discovery sources configured");
  }
  if (!enabled.some((s) => s.source_key === state.currentSourceKey)) {
    state.currentSourceKey = enabled[0].source_key;
  }
}

function applyAdvance(
  state: MemoryState,
  fromSourceKey: string,
): { nextSourceKey: string; nextCycleId: number; wrapped: boolean } {
  const next = advanceDiscoveryCursor(state.sources, fromSourceKey, state.cycleId);
  state.cycleId = next.nextCycleId;
  state.currentSourceKey = next.nextSourceKey;
  state.activeRunId = null;
  if (next.wrapped) {
    state.sourceFailureCounts = clearFailureCounts();
  }
  return next;
}

function failRunMemory(
  state: MemoryState,
  run: DiscoverySourceRun,
  sanitized: string,
  checkpoint?: Record<string, unknown>,
  status: DiscoveryRunStatus = "failed",
): void {
  run.status = status;
  run.completed_at = new Date().toISOString();
  run.last_error = sanitized;
  if (checkpoint) run.checkpoint = checkpoint;
}

async function ensurePostgresSeeded(): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO discovery_sources (source_key, display_name, source_order, enabled)
    VALUES
      ('ashby', 'Ashby', 1, TRUE),
      ('greenhouse', 'Greenhouse', 2, TRUE),
      ('lever', 'Lever', 3, TRUE),
      ('workday', 'Workday', 4, TRUE),
      ('company_careers', 'Company careers pages', 5, TRUE)
    ON CONFLICT (source_key) DO NOTHING
  `;
  await sql`
    INSERT INTO discovery_rotation_state (
      id, cycle_id, current_source_key, active_run_id, source_failure_counts
    )
    VALUES (1, 1, 'ashby', NULL, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function getDiscoveryRotation(): Promise<DiscoveryRotationSnapshot> {
  const maxAttempts = getMaxAttempts();

  if (useMemoryBackend) {
    const state = requireMemory();
    return {
      cycle_id: state.cycleId,
      current_source_key: state.currentSourceKey,
      active_run_id: state.activeRunId,
      source_failure_counts: { ...state.sourceFailureCounts },
      max_attempts: maxAttempts,
      sources: state.sources.map((s) => ({ ...s })),
      enabled_sources: listEnabledSourcesOrdered(state.sources).map((s) => ({ ...s })),
      latest_run: latestRunFromMemory(state),
    };
  }

  await ensurePostgresSeeded();
  const sql = getSql();
  const sources = (
    await sql`
      SELECT source_key, display_name, source_order, enabled
      FROM discovery_sources
      ORDER BY source_order ASC, source_key ASC
    `
  ).map((row) => mapRow<DiscoverySourceRecord>(row as Record<string, unknown>));

  const stateRows = await sql`
    SELECT cycle_id, current_source_key, active_run_id, source_failure_counts
    FROM discovery_rotation_state
    WHERE id = 1
    LIMIT 1
  `;
  if (!stateRows.length) {
    throw new DiscoveryRotationError("Discovery rotation state is not initialized");
  }
  const state = mapRow<Record<string, unknown>>(stateRows[0] as Record<string, unknown>);

  let latest: DiscoverySourceRun | null = null;
  if (state.active_run_id) {
    const runRows = await sql`
      SELECT * FROM discovery_source_runs WHERE id = ${String(state.active_run_id)}::uuid LIMIT 1
    `;
    if (runRows.length) latest = mapRun(runRows[0] as Record<string, unknown>);
  } else {
    const runRows = await sql`
      SELECT * FROM discovery_source_runs
      ORDER BY started_at DESC, created_at DESC
      LIMIT 1
    `;
    if (runRows.length) latest = mapRun(runRows[0] as Record<string, unknown>);
  }

  return {
    cycle_id: Number(state.cycle_id),
    current_source_key: String(state.current_source_key),
    active_run_id: state.active_run_id == null ? null : String(state.active_run_id),
    source_failure_counts: parseFailureCounts(state.source_failure_counts),
    max_attempts: maxAttempts,
    sources,
    enabled_sources: listEnabledSourcesOrdered(sources),
    latest_run: latest,
  };
}

export async function claimNextDiscoverySource(): Promise<ClaimDiscoverySourceResult> {
  if (useMemoryBackend) {
    const state = requireMemory();
    const now = new Date();
    const maxAttempts = getMaxAttempts();
    let recovered: string | null = null;
    let staleSourceKey: string | null = null;
    let staleSourceSkipped = false;

    if (state.activeRunId) {
      const active = state.runs.get(state.activeRunId);
      if (active && active.status === "claimed") {
        if (!isClaimStale(active.started_at, now)) {
          throw new DiscoveryRotationError(
            `Discovery source '${state.currentSourceKey}' is already claimed by run ${active.id}`,
          );
        }
        staleSourceKey = active.source_key;
        recovered = active.id;
        state.sourceFailureCounts = incrementFailureCount(
          state.sourceFailureCounts,
          active.source_key,
        );
        const consecutive = state.sourceFailureCounts[active.source_key] ?? 0;
        const staleMessage = sanitizeDiscoveryError(
          "Stale discovery source claim recovered after timeout",
        );

        if (shouldSkipAfterFailure(consecutive, maxAttempts)) {
          failRunMemory(
            state,
            active,
            staleMessage,
            undefined,
            "skipped_after_failures",
          );
          state.sourceFailureCounts = resetFailureCountForSource(
            state.sourceFailureCounts,
            active.source_key,
          );
          applyAdvance(state, active.source_key);
          staleSourceSkipped = true;
        } else {
          failRunMemory(state, active, staleMessage);
          state.activeRunId = null;
        }
      } else {
        state.activeRunId = null;
      }
    }

    resolveCurrentSourceKey(state);
    const source = state.sources.find((s) => s.source_key === state.currentSourceKey)!;
    const attemptNumber = (state.sourceFailureCounts[source.source_key] ?? 0) + 1;
    if (attemptNumber > maxAttempts) {
      throw new DiscoveryRotationError(
        `Attempt number ${attemptNumber} exceeds max attempts ${maxAttempts} for source '${source.source_key}'`,
      );
    }
    const runId = randomUUID();
    const run: DiscoverySourceRun = {
      id: runId,
      cycle_id: state.cycleId,
      source_key: source.source_key,
      status: "claimed",
      attempt_number: attemptNumber,
      started_at: now.toISOString(),
      completed_at: null,
      last_success_at: null,
      last_error: null,
      checkpoint: {},
      discovered_count: 0,
      preflight_skipped_count: 0,
      evaluated_count: 0,
      qualified_count: 0,
      submitted_count: 0,
    };
    state.runs.set(runId, run);
    state.activeRunId = runId;

    return {
      run_id: runId,
      cycle_id: state.cycleId,
      source_key: source.source_key,
      display_name: source.display_name,
      attempt_number: attemptNumber,
      checkpoint: {},
      started_at: run.started_at,
      recovered_stale_run_id: recovered,
      stale_source_key: staleSourceKey,
      stale_source_skipped: staleSourceSkipped,
    };
  }

  await ensurePostgresSeeded();
  const sql = getSql();
  const timeoutMs = getClaimTimeoutMs();
  const timeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60000));
  const maxAttempts = getMaxAttempts();
  const staleMessage = "Stale discovery source claim recovered after timeout";

  const rows = await sql`
    WITH locked_state AS (
      SELECT id, cycle_id, current_source_key, active_run_id, source_failure_counts
      FROM discovery_rotation_state
      WHERE id = 1
      FOR UPDATE
    ),
    stale_candidate AS (
      SELECT r.id, r.source_key
      FROM locked_state s
      JOIN discovery_source_runs r ON r.id = s.active_run_id
      WHERE r.status = 'claimed'
        AND r.started_at <= NOW() - (${String(timeoutMinutes) + " minutes"})::interval
    ),
    stale_bump AS (
      SELECT
        sc.id,
        sc.source_key,
        COALESCE((ls.source_failure_counts ->> sc.source_key)::int, 0) + 1 AS consecutive
      FROM stale_candidate sc
      CROSS JOIN locked_state ls
    ),
    stale_failed AS (
      UPDATE discovery_source_runs r
      SET
        status = 'failed',
        completed_at = NOW(),
        last_error = ${staleMessage},
        updated_at = NOW()
      FROM stale_bump b
      WHERE r.id = b.id
        AND b.consecutive < ${maxAttempts}
      RETURNING r.id, r.source_key, b.consecutive
    ),
    stale_skipped AS (
      UPDATE discovery_source_runs r
      SET
        status = 'skipped_after_failures',
        completed_at = NOW(),
        last_error = ${staleMessage},
        updated_at = NOW()
      FROM stale_bump b
      WHERE r.id = b.id
        AND b.consecutive >= ${maxAttempts}
      RETURNING r.id, r.source_key, b.consecutive
    ),
    enabled AS (
      SELECT source_key, source_order, display_name
      FROM discovery_sources
      WHERE enabled = TRUE
    ),
    skipped_pos AS (
      SELECT COALESCE(
        (SELECT source_order FROM discovery_sources WHERE source_key = (SELECT source_key FROM stale_skipped LIMIT 1)),
        0
      ) AS source_order
    ),
    next_after_skip AS (
      SELECT e.source_key
      FROM enabled e, skipped_pos p
      WHERE EXISTS (SELECT 1 FROM stale_skipped)
        AND e.source_order > p.source_order
      ORDER BY e.source_order ASC, e.source_key ASC
      LIMIT 1
    ),
    first_enabled AS (
      SELECT source_key FROM enabled ORDER BY source_order ASC, source_key ASC LIMIT 1
    ),
    apply_stale_state AS (
      UPDATE discovery_rotation_state s
      SET
        active_run_id = NULL,
        current_source_key = CASE
          WHEN EXISTS (SELECT 1 FROM stale_skipped) THEN COALESCE(
            (SELECT source_key FROM next_after_skip),
            (SELECT source_key FROM first_enabled)
          )
          ELSE s.current_source_key
        END,
        cycle_id = CASE
          WHEN EXISTS (SELECT 1 FROM stale_skipped)
            AND NOT EXISTS (SELECT 1 FROM next_after_skip)
            THEN s.cycle_id + 1
          ELSE s.cycle_id
        END,
        source_failure_counts = CASE
          WHEN EXISTS (SELECT 1 FROM stale_skipped) THEN
            CASE
              WHEN EXISTS (SELECT 1 FROM next_after_skip) THEN
                COALESCE(s.source_failure_counts, '{}'::jsonb)
                  - (SELECT source_key FROM stale_skipped LIMIT 1)
              ELSE '{}'::jsonb
            END
          WHEN EXISTS (SELECT 1 FROM stale_failed) THEN
            jsonb_set(
              COALESCE(s.source_failure_counts, '{}'::jsonb),
              ARRAY[(SELECT source_key FROM stale_failed LIMIT 1)],
              to_jsonb((SELECT consecutive FROM stale_failed LIMIT 1)),
              true
            )
          ELSE COALESCE(s.source_failure_counts, '{}'::jsonb)
        END,
        updated_at = NOW()
      WHERE s.id = 1
        AND (EXISTS (SELECT 1 FROM stale_failed) OR EXISTS (SELECT 1 FROM stale_skipped))
      RETURNING s.*
    ),
    active_block AS (
      SELECT r.id
      FROM discovery_rotation_state s
      JOIN discovery_source_runs r ON r.id = s.active_run_id
      WHERE s.id = 1
        AND r.status = 'claimed'
        AND r.started_at > NOW() - (${String(timeoutMinutes) + " minutes"})::interval
    ),
    resolved_source AS (
      SELECT ds.source_key, ds.display_name, ds.source_order
      FROM discovery_rotation_state s
      JOIN discovery_sources ds ON ds.source_key = s.current_source_key AND ds.enabled = TRUE
      WHERE s.id = 1
      UNION ALL
      SELECT ds.source_key, ds.display_name, ds.source_order
      FROM discovery_sources ds
      WHERE ds.enabled = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM discovery_rotation_state s
          JOIN discovery_sources cur
            ON cur.source_key = s.current_source_key AND cur.enabled = TRUE
          WHERE s.id = 1
        )
    ),
    picked_source AS (
      SELECT source_key, display_name
      FROM resolved_source
      ORDER BY source_order ASC, source_key ASC
      LIMIT 1
    ),
    attempt AS (
      SELECT
        p.source_key,
        p.display_name,
        COALESCE((s.source_failure_counts ->> p.source_key)::int, 0) + 1 AS attempt_number
      FROM picked_source p
      CROSS JOIN discovery_rotation_state s
      WHERE s.id = 1
    ),
    inserted AS (
      INSERT INTO discovery_source_runs (
        cycle_id, source_key, status, attempt_number, started_at, checkpoint
      )
      SELECT s.cycle_id, a.source_key, 'claimed', a.attempt_number, NOW(), '{}'::jsonb
      FROM discovery_rotation_state s
      CROSS JOIN attempt a
      WHERE NOT EXISTS (SELECT 1 FROM active_block)
        AND EXISTS (SELECT 1 FROM picked_source)
        AND a.attempt_number <= ${maxAttempts}
      RETURNING *
    ),
    updated_state AS (
      UPDATE discovery_rotation_state s
      SET
        current_source_key = i.source_key,
        active_run_id = i.id,
        updated_at = NOW()
      FROM inserted i
      WHERE s.id = 1
      RETURNING s.id
    )
    SELECT
      i.id AS run_id,
      i.cycle_id,
      i.source_key,
      a.display_name,
      i.attempt_number,
      i.checkpoint,
      i.started_at,
      COALESCE(
        (SELECT id FROM stale_skipped LIMIT 1),
        (SELECT id FROM stale_failed LIMIT 1)
      ) AS recovered_stale_run_id,
      COALESCE(
        (SELECT source_key FROM stale_skipped LIMIT 1),
        (SELECT source_key FROM stale_failed LIMIT 1)
      ) AS stale_source_key,
      EXISTS (SELECT 1 FROM stale_skipped) AS stale_source_skipped
    FROM inserted i
    JOIN attempt a ON a.source_key = i.source_key
  `;

  if (!rows.length) {
    const blockCheck = await sql`
      SELECT r.id
      FROM discovery_rotation_state s
      JOIN discovery_source_runs r ON r.id = s.active_run_id
      WHERE s.id = 1
        AND r.status = 'claimed'
        AND r.started_at > NOW() - (${String(timeoutMinutes) + " minutes"})::interval
      LIMIT 1
    `;
    if (blockCheck.length) {
      throw new DiscoveryRotationError(
        "Discovery source is already claimed by an active run",
      );
    }
    throw new DiscoveryRotationError("No enabled discovery sources configured");
  }

  const row = rows[0] as Record<string, unknown>;
  return {
    run_id: String(row.run_id),
    cycle_id: Number(row.cycle_id),
    source_key: String(row.source_key),
    display_name: String(row.display_name),
    attempt_number: Number(row.attempt_number),
    checkpoint: parseCheckpoint(row.checkpoint),
    started_at:
      row.started_at instanceof Date
        ? row.started_at.toISOString()
        : String(row.started_at),
    recovered_stale_run_id:
      row.recovered_stale_run_id == null ? null : String(row.recovered_stale_run_id),
    stale_source_key: row.stale_source_key == null ? null : String(row.stale_source_key),
    stale_source_skipped: Boolean(row.stale_source_skipped),
  };
}

export async function completeDiscoverySource(
  input: z.infer<typeof completeDiscoverySourceSchema>,
): Promise<CompleteDiscoverySourceResult> {
  const parsed = completeDiscoverySourceSchema.parse(input);

  if (useMemoryBackend) {
    const state = requireMemory();
    const run = state.runs.get(parsed.run_id);
    if (!run) throw new DiscoveryRotationError(`Unknown discovery run: ${parsed.run_id}`);
    if (run.status !== "claimed") {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is ${run.status} and cannot be completed`,
      );
    }
    if (state.activeRunId !== run.id) {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is not the active claim`,
      );
    }

    const now = new Date().toISOString();
    run.status = "completed";
    run.completed_at = now;
    run.last_success_at = now;
    run.last_error = null;
    run.checkpoint = parsed.checkpoint ?? run.checkpoint;
    run.discovered_count = parsed.discovered_count;
    run.preflight_skipped_count = parsed.preflight_skipped_count;
    run.evaluated_count = parsed.evaluated_count;
    run.qualified_count = parsed.qualified_count;
    run.submitted_count = parsed.submitted_count;

    state.sourceFailureCounts = resetFailureCountForSource(
      state.sourceFailureCounts,
      run.source_key,
    );
    const next = applyAdvance(state, run.source_key);

    return {
      run: cloneRun(run),
      next_source_key: next.nextSourceKey,
      next_cycle_id: next.nextCycleId,
      wrapped: next.wrapped,
    };
  }

  await ensurePostgresSeeded();
  const sql = getSql();
  const hasCheckpoint = parsed.checkpoint !== undefined;
  const checkpointJson = JSON.stringify(parsed.checkpoint ?? {});

  const rows = await sql`
    WITH locked_state AS (
      SELECT *
      FROM discovery_rotation_state
      WHERE id = 1
      FOR UPDATE
    ),
    completed AS (
      UPDATE discovery_source_runs r
      SET
        status = 'completed',
        completed_at = NOW(),
        last_success_at = NOW(),
        last_error = NULL,
        checkpoint = CASE
          WHEN ${hasCheckpoint} THEN ${checkpointJson}::jsonb
          ELSE r.checkpoint
        END,
        discovered_count = ${parsed.discovered_count},
        preflight_skipped_count = ${parsed.preflight_skipped_count},
        evaluated_count = ${parsed.evaluated_count},
        qualified_count = ${parsed.qualified_count},
        submitted_count = ${parsed.submitted_count},
        updated_at = NOW()
      FROM locked_state s
      WHERE r.id = ${parsed.run_id}::uuid
        AND r.status = 'claimed'
        AND s.active_run_id = r.id
      RETURNING r.*
    ),
    reset_failures AS (
      UPDATE discovery_rotation_state s
      SET
        source_failure_counts = COALESCE(s.source_failure_counts, '{}'::jsonb)
          - (SELECT source_key FROM completed),
        updated_at = NOW()
      FROM completed
      WHERE s.id = 1
      RETURNING s.*
    ),
    enabled AS (
      SELECT source_key, source_order
      FROM discovery_sources
      WHERE enabled = TRUE
    ),
    current_pos AS (
      SELECT COALESCE(
        (SELECT source_order FROM discovery_sources WHERE source_key = (SELECT source_key FROM completed)),
        0
      ) AS source_order
    ),
    next_source AS (
      SELECT e.source_key
      FROM enabled e, current_pos c
      WHERE e.source_order > c.source_order
      ORDER BY e.source_order ASC, e.source_key ASC
      LIMIT 1
    ),
    first_source AS (
      SELECT source_key FROM enabled ORDER BY source_order ASC, source_key ASC LIMIT 1
    ),
    advanced AS (
      UPDATE discovery_rotation_state s
      SET
        current_source_key = COALESCE(
          (SELECT source_key FROM next_source),
          (SELECT source_key FROM first_source)
        ),
        cycle_id = CASE
          WHEN EXISTS (SELECT 1 FROM next_source) THEN s.cycle_id
          ELSE s.cycle_id + 1
        END,
        source_failure_counts = CASE
          WHEN EXISTS (SELECT 1 FROM next_source) THEN s.source_failure_counts
          ELSE '{}'::jsonb
        END,
        active_run_id = NULL,
        updated_at = NOW()
      FROM completed
      WHERE s.id = 1
      RETURNING
        s.current_source_key AS next_source_key,
        s.cycle_id AS next_cycle_id,
        NOT EXISTS (SELECT 1 FROM next_source) AS wrapped
    )
    SELECT
      row_to_json(c.*) AS run,
      a.next_source_key,
      a.next_cycle_id,
      a.wrapped
    FROM completed c
    CROSS JOIN advanced a
  `;

  if (!rows.length) {
    const check = await sql`
      SELECT r.status, s.active_run_id
      FROM discovery_source_runs r
      LEFT JOIN discovery_rotation_state s ON s.id = 1
      WHERE r.id = ${parsed.run_id}::uuid
      LIMIT 1
    `;
    if (!check.length) {
      throw new DiscoveryRotationError(`Unknown discovery run: ${parsed.run_id}`);
    }
    const status = String((check[0] as Record<string, unknown>).status);
    if (status !== "claimed") {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is ${status} and cannot be completed`,
      );
    }
    throw new DiscoveryRotationError(
      `Discovery run ${parsed.run_id} is not the active claim`,
    );
  }

  const row = rows[0] as Record<string, unknown>;
  return {
    run: mapRun(row.run as Record<string, unknown>),
    next_source_key: String(row.next_source_key),
    next_cycle_id: Number(row.next_cycle_id),
    wrapped: Boolean(row.wrapped),
  };
}

export async function failDiscoverySource(
  input: z.infer<typeof failDiscoverySourceSchema>,
): Promise<FailDiscoverySourceResult> {
  const parsed = failDiscoverySourceSchema.parse(input);
  const sanitized = sanitizeDiscoveryError(parsed.error);
  const maxAttempts = getMaxAttempts();

  if (useMemoryBackend) {
    const state = requireMemory();
    const run = state.runs.get(parsed.run_id);
    if (!run) throw new DiscoveryRotationError(`Unknown discovery run: ${parsed.run_id}`);
    if (run.status !== "claimed") {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is ${run.status} and cannot be failed`,
      );
    }
    if (state.activeRunId !== run.id) {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is not the active claim`,
      );
    }

    state.sourceFailureCounts = incrementFailureCount(
      state.sourceFailureCounts,
      run.source_key,
    );
    const consecutive = state.sourceFailureCounts[run.source_key] ?? 0;

    if (shouldSkipAfterFailure(consecutive, maxAttempts)) {
      failRunMemory(
        state,
        run,
        sanitized,
        parsed.checkpoint,
        "skipped_after_failures",
      );
      state.sourceFailureCounts = resetFailureCountForSource(
        state.sourceFailureCounts,
        run.source_key,
      );
      const next = applyAdvance(state, run.source_key);
      return {
        run: cloneRun(run),
        next_source_key: next.nextSourceKey,
        next_cycle_id: next.nextCycleId,
        wrapped: next.wrapped,
        consecutive_failures: consecutive,
        max_attempts: maxAttempts,
        retry_required: false,
        auto_advanced: true,
      };
    }

    failRunMemory(state, run, sanitized, parsed.checkpoint, "failed");
    state.activeRunId = null;

    return {
      run: cloneRun(run),
      cursor_source_key: state.currentSourceKey,
      cycle_id: state.cycleId,
      consecutive_failures: consecutive,
      max_attempts: maxAttempts,
      retry_required: true,
      auto_advanced: false,
    };
  }

  await ensurePostgresSeeded();
  const sql = getSql();
  const hasCheckpoint = parsed.checkpoint !== undefined;
  const checkpointJson = JSON.stringify(parsed.checkpoint ?? {});

  const rows = await sql`
    WITH locked_state AS (
      SELECT *
      FROM discovery_rotation_state
      WHERE id = 1
      FOR UPDATE
    ),
    bumped AS (
      UPDATE discovery_rotation_state s
      SET
        source_failure_counts = jsonb_set(
          COALESCE(s.source_failure_counts, '{}'::jsonb),
          ARRAY[(SELECT source_key FROM discovery_source_runs WHERE id = ${parsed.run_id}::uuid)],
          to_jsonb(
            COALESCE(
              (s.source_failure_counts ->> (
                SELECT source_key FROM discovery_source_runs WHERE id = ${parsed.run_id}::uuid
              ))::int,
              0
            ) + 1
          ),
          true
        ),
        updated_at = NOW()
      FROM locked_state ls
      WHERE s.id = 1
        AND EXISTS (
          SELECT 1 FROM discovery_source_runs r
          WHERE r.id = ${parsed.run_id}::uuid AND r.status = 'claimed' AND ls.active_run_id = r.id
        )
      RETURNING
        s.*,
        COALESCE(
          (s.source_failure_counts ->> (
            SELECT source_key FROM discovery_source_runs WHERE id = ${parsed.run_id}::uuid
          ))::int,
          0
        ) AS consecutive_failures
    ),
    skip AS (
      UPDATE discovery_source_runs r
      SET
        status = 'skipped_after_failures',
        completed_at = NOW(),
        last_error = ${sanitized},
        checkpoint = CASE
          WHEN ${hasCheckpoint} THEN ${checkpointJson}::jsonb
          ELSE r.checkpoint
        END,
        updated_at = NOW()
      FROM bumped b
      WHERE r.id = ${parsed.run_id}::uuid
        AND r.status = 'claimed'
        AND b.active_run_id = r.id
        AND b.consecutive_failures >= ${maxAttempts}
      RETURNING r.*
    ),
    retry AS (
      UPDATE discovery_source_runs r
      SET
        status = 'failed',
        completed_at = NOW(),
        last_error = ${sanitized},
        checkpoint = CASE
          WHEN ${hasCheckpoint} THEN ${checkpointJson}::jsonb
          ELSE r.checkpoint
        END,
        updated_at = NOW()
      FROM bumped b
      WHERE r.id = ${parsed.run_id}::uuid
        AND r.status = 'claimed'
        AND b.active_run_id = r.id
        AND b.consecutive_failures < ${maxAttempts}
      RETURNING r.*
    ),
    enabled AS (
      SELECT source_key, source_order
      FROM discovery_sources
      WHERE enabled = TRUE
    ),
    current_pos AS (
      SELECT COALESCE(
        (SELECT source_order FROM discovery_sources WHERE source_key = (SELECT source_key FROM skip)),
        0
      ) AS source_order
    ),
    next_source AS (
      SELECT e.source_key
      FROM enabled e, current_pos c
      WHERE e.source_order > c.source_order
      ORDER BY e.source_order ASC, e.source_key ASC
      LIMIT 1
    ),
    first_source AS (
      SELECT source_key FROM enabled ORDER BY source_order ASC, source_key ASC LIMIT 1
    ),
    advanced AS (
      UPDATE discovery_rotation_state s
      SET
        current_source_key = COALESCE(
          (SELECT source_key FROM next_source),
          (SELECT source_key FROM first_source)
        ),
        cycle_id = CASE
          WHEN EXISTS (SELECT 1 FROM next_source) THEN s.cycle_id
          ELSE s.cycle_id + 1
        END,
        source_failure_counts = CASE
          WHEN EXISTS (SELECT 1 FROM next_source) THEN
            COALESCE(s.source_failure_counts, '{}'::jsonb)
              - (SELECT source_key FROM skip)
          ELSE '{}'::jsonb
        END,
        active_run_id = NULL,
        updated_at = NOW()
      FROM skip
      WHERE s.id = 1
      RETURNING
        s.current_source_key AS next_source_key,
        s.cycle_id AS next_cycle_id,
        NOT EXISTS (SELECT 1 FROM next_source) AS wrapped
    ),
    cleared_retry AS (
      UPDATE discovery_rotation_state s
      SET active_run_id = NULL, updated_at = NOW()
      FROM retry
      WHERE s.id = 1
      RETURNING s.current_source_key, s.cycle_id
    )
    SELECT
      'skip' AS outcome,
      row_to_json(sk.*) AS run,
      NULL::text AS cursor_source_key,
      NULL::integer AS cycle_id,
      a.next_source_key,
      a.next_cycle_id,
      a.wrapped,
      b.consecutive_failures
    FROM skip sk
    CROSS JOIN bumped b
    CROSS JOIN advanced a
    UNION ALL
    SELECT
      'retry' AS outcome,
      row_to_json(rt.*) AS run,
      c.current_source_key AS cursor_source_key,
      c.cycle_id,
      NULL::text AS next_source_key,
      NULL::integer AS next_cycle_id,
      NULL::boolean AS wrapped,
      b.consecutive_failures
    FROM retry rt
    CROSS JOIN bumped b
    CROSS JOIN cleared_retry c
  `;

  if (!rows.length) {
    const check = await sql`
      SELECT r.status, s.active_run_id
      FROM discovery_source_runs r
      LEFT JOIN discovery_rotation_state s ON s.id = 1
      WHERE r.id = ${parsed.run_id}::uuid
      LIMIT 1
    `;
    if (!check.length) {
      throw new DiscoveryRotationError(`Unknown discovery run: ${parsed.run_id}`);
    }
    const status = String((check[0] as Record<string, unknown>).status);
    if (status !== "claimed") {
      throw new DiscoveryRotationError(
        `Discovery run ${parsed.run_id} is ${status} and cannot be failed`,
      );
    }
    throw new DiscoveryRotationError(
      `Discovery run ${parsed.run_id} is not the active claim`,
    );
  }

  const row = rows[0] as Record<string, unknown>;
  const consecutive = Number(row.consecutive_failures);

  if (row.outcome === "skip") {
    return {
      run: mapRun(row.run as Record<string, unknown>),
      next_source_key: String(row.next_source_key),
      next_cycle_id: Number(row.next_cycle_id),
      wrapped: Boolean(row.wrapped),
      consecutive_failures: consecutive,
      max_attempts: maxAttempts,
      retry_required: false,
      auto_advanced: true,
    };
  }

  return {
    run: mapRun(row.run as Record<string, unknown>),
    cursor_source_key: String(row.cursor_source_key),
    cycle_id: Number(row.cycle_id),
    consecutive_failures: consecutive,
    max_attempts: maxAttempts,
    retry_required: true,
    auto_advanced: false,
  };
}
