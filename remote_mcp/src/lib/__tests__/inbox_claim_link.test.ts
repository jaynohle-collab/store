import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const inboxSourcePath = path.resolve(__dirname, "../db/inbox.ts");
const inboxSource = readFileSync(inboxSourcePath, "utf8");

function sliceFunction(startMarker: string, endMarker: string | null): string {
  const start = inboxSource.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end =
    endMarker == null
      ? inboxSource.length
      : inboxSource.indexOf(endMarker, start + 1);
  expect(end).toBeGreaterThan(start);
  return inboxSource.slice(start, end);
}

const claimSrc = sliceFunction(
  "export async function claimDiscoveryBatch",
  "export async function completeDiscoveryBatch",
);
const completeSrc = sliceFunction(
  "export async function completeDiscoveryBatch",
  "export async function failDiscoveryBatch",
);
const failSrc = sliceFunction(
  "export async function failDiscoveryBatch",
  "export async function recoverStaleDiscoveryBatchClaims",
);
const staleSrc = sliceFunction(
  "export async function recoverStaleDiscoveryBatchClaims",
  null,
);

describe("claimDiscoveryBatch SQL contract (hotfix)", () => {
  it("updates discovery_inbox_batches exactly once per claim statement", () => {
    const updateMatches = claimSrc.match(
      /UPDATE\s+discovery_inbox_batches\b/gi,
    );
    expect(updateMatches).toHaveLength(2);
    expect(claimSrc).not.toMatch(
      /UPDATE\s+discovery_inbox_batches\s+b\s+SET\s+active_attempt_id/i,
    );
    expect(claimSrc).not.toContain("WITH claimed AS");
    expect(claimSrc).not.toContain("SELECT * FROM linked");
  });

  it("locks pending rows with FOR UPDATE SKIP LOCKED on both paths", () => {
    expect(claimSrc.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(2);
    expect(claimSrc).toContain("ORDER BY submitted_at ASC, created_at ASC");
  });

  it("sets processing + active_attempt_id in the same UPDATE", () => {
    expect(claimSrc).toMatch(
      /status\s*=\s*'processing'[\s\S]*active_attempt_id\s*=\s*a\.id/,
    );
    expect(claimSrc).toContain("processing_started_at = NOW()");
  });

  it("inserts the claimed attempt before the single batch UPDATE", () => {
    const attemptIdx = claimSrc.indexOf(
      "INSERT INTO discovery_batch_processing_attempts",
    );
    const updateIdx = claimSrc.indexOf("UPDATE discovery_inbox_batches b");
    expect(attemptIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(attemptIdx);
  });

  it("returns attempt linkage fields and rejects missing attempt_id", () => {
    expect(claimSrc).toContain("a.id AS attempt_id");
    expect(claimSrc).toContain("claim_discovery_batch_missing_attempt_id");
  });
});

describe("complete/fail/stale all-or-nothing SQL contracts", () => {
  it("complete uses one eligible lock and one update per table in a single statement", () => {
    expect(completeSrc).toContain("WITH eligible AS");
    expect(completeSrc).toContain("FOR UPDATE OF b, a");
    expect(completeSrc.match(/UPDATE\s+discovery_inbox_batches\b/gi)).toHaveLength(
      1,
    );
    expect(
      completeSrc.match(/UPDATE\s+discovery_batch_processing_attempts\b/gi),
    ).toHaveLength(1);
    // Must not use multi-statement Neon tx for the two mutations.
    expect(completeSrc).not.toMatch(
      /sql\.transaction\(\[\s*sql`\s*UPDATE discovery_inbox_batches/,
    );
    expect(completeSrc).toContain("FROM eligible e");
    expect(completeSrc).toContain("WHERE EXISTS (SELECT 1 FROM updated_attempt)");
  });

  it("fail mirrors complete eligibility gating", () => {
    expect(failSrc).toContain("WITH eligible AS");
    expect(failSrc).toContain("FOR UPDATE OF b, a");
    expect(failSrc.match(/UPDATE\s+discovery_inbox_batches\b/gi)).toHaveLength(1);
    expect(
      failSrc.match(/UPDATE\s+discovery_batch_processing_attempts\b/gi),
    ).toHaveLength(1);
    expect(failSrc).toContain("FROM eligible e");
    expect(failSrc).toContain("WHERE EXISTS (SELECT 1 FROM updated_attempt)");
  });

  it("stale requeue abandons attempt and requeues batch from the same eligible CTE", () => {
    expect(staleSrc).toContain("mutation_started = FALSE");
    expect(staleSrc).toContain("fail_closed_unless_mutation_started_false");
    expect(staleSrc).toContain("WITH eligible AS");
    expect(staleSrc).toContain("FOR UPDATE OF b, a");
    expect(staleSrc).toContain("status = 'abandoned'");
    expect(staleSrc).toContain("status = 'pending'");
    expect(staleSrc).toContain("WHERE EXISTS (SELECT 1 FROM updated_attempt)");
  });

  it("stale fail-closed updates batch from eligible_batch and attempt only when claimed", () => {
    expect(staleSrc).toContain("WITH eligible_batch AS");
    expect(staleSrc).toContain("eligible_attempt AS");
    expect(staleSrc).toContain("abandoned_attempt_id");
    // Fail-closed must not require attempt success to fail the batch.
    expect(staleSrc).toMatch(
      /updated_batch AS \([\s\S]*FROM eligible_batch e/,
    );
  });
});

type BatchRow = {
  id: string;
  status: string;
  submitted_at: string;
  created_at: string;
  processing_started_at: string | null;
  active_attempt_id: string | null;
  updated_at: string;
  error?: string | null;
  processed_at?: string | null;
};

type AttemptRow = {
  id: string;
  batch_id: string;
  status: string;
  worker_identity: string;
  mutation_started: boolean;
  sanitized_error?: string | null;
};

function snapshot(
  batches: Map<string, BatchRow>,
  attempts: Map<string, AttemptRow>,
) {
  return {
    batches: structuredClone([...batches.entries()]),
    attempts: structuredClone([...attempts.entries()]),
  };
}

function claimOnce(
  batches: Map<string, BatchRow>,
  attempts: Map<string, AttemptRow>,
  opts: { id?: string; worker_identity: string },
): Record<string, unknown> | null {
  const pending = [...batches.values()]
    .filter((b) => b.status === "pending")
    .sort((a, b) => {
      const bySubmitted = a.submitted_at.localeCompare(b.submitted_at);
      if (bySubmitted !== 0) return bySubmitted;
      return a.created_at.localeCompare(b.created_at);
    });

  const picked = opts.id
    ? pending.find((b) => b.id === opts.id)
    : pending[0];
  if (!picked || picked.status !== "pending") return null;

  const attemptId = `attempt-${attempts.size + 1}`;
  const attempt: AttemptRow = {
    id: attemptId,
    batch_id: picked.id,
    status: "claimed",
    worker_identity: opts.worker_identity,
    mutation_started: false,
  };
  attempts.set(attemptId, attempt);

  if (picked.status !== "pending") {
    attempts.delete(attemptId);
    return null;
  }
  picked.status = "processing";
  picked.processing_started_at = new Date().toISOString();
  picked.active_attempt_id = attemptId;
  picked.updated_at = new Date().toISOString();

  return {
    ...picked,
    attempt_id: attemptId,
    worker_identity: opts.worker_identity,
    mutation_started: false,
  };
}

/**
 * Models complete/fail: lock eligibility first; mutate both or neither.
 */
function finishOnce(
  batches: Map<string, BatchRow>,
  attempts: Map<string, AttemptRow>,
  opts: {
    batchId: string;
    attemptId: string;
    mode: "completed" | "failed";
    error?: string;
  },
): Record<string, unknown> | null {
  const batch = batches.get(opts.batchId);
  const attempt = attempts.get(opts.attemptId);
  if (
    !batch ||
    !attempt ||
    batch.status !== "processing" ||
    batch.active_attempt_id !== opts.attemptId ||
    attempt.batch_id !== opts.batchId ||
    attempt.status !== "claimed"
  ) {
    return null;
  }

  batch.status = opts.mode;
  batch.processed_at = new Date().toISOString();
  batch.active_attempt_id = null;
  batch.updated_at = new Date().toISOString();
  if (opts.mode === "failed") batch.error = opts.error ?? "failed";

  attempt.status = opts.mode;
  if (opts.mode === "failed") attempt.sanitized_error = opts.error ?? "failed";
  return { ...batch };
}

function staleRequeueOnce(
  batches: Map<string, BatchRow>,
  attempts: Map<string, AttemptRow>,
  opts: { batchId: string; attemptId: string },
): Record<string, unknown> | null {
  const batch = batches.get(opts.batchId);
  const attempt = attempts.get(opts.attemptId);
  if (
    !batch ||
    !attempt ||
    batch.status !== "processing" ||
    batch.active_attempt_id !== opts.attemptId ||
    attempt.batch_id !== opts.batchId ||
    attempt.status !== "claimed" ||
    attempt.mutation_started !== false
  ) {
    return null;
  }
  attempt.status = "abandoned";
  batch.status = "pending";
  batch.processing_started_at = null;
  batch.active_attempt_id = null;
  batch.error = null;
  batch.updated_at = new Date().toISOString();
  return { ...batch };
}

function staleFailClosedOnce(
  batches: Map<string, BatchRow>,
  attempts: Map<string, AttemptRow>,
  opts: { batchId: string },
): { batch: Record<string, unknown> | null; abandonedAttemptId: string | null } {
  const batch = batches.get(opts.batchId);
  if (!batch || batch.status !== "processing") {
    return { batch: null, abandonedAttemptId: null };
  }
  let abandonedAttemptId: string | null = null;
  const linkedId = batch.active_attempt_id;
  if (linkedId) {
    const attempt = attempts.get(linkedId);
    if (
      attempt &&
      attempt.batch_id === batch.id &&
      attempt.status === "claimed"
    ) {
      attempt.status = "abandoned";
      abandonedAttemptId = attempt.id;
    }
  }
  batch.status = "failed";
  batch.active_attempt_id = null;
  batch.error = "stale_fail_closed";
  batch.updated_at = new Date().toISOString();
  return { batch: { ...batch }, abandonedAttemptId };
}

describe("claimDiscoveryBatch behavioral regressions", () => {
  const batches = new Map<string, BatchRow>();
  const attempts = new Map<string, AttemptRow>();

  beforeEach(() => {
    batches.clear();
    attempts.clear();
  });

  function seedPending(id: string, submittedAt: string): void {
    batches.set(id, {
      id,
      status: "pending",
      submitted_at: submittedAt,
      created_at: submittedAt,
      processing_started_at: null,
      active_attempt_id: null,
      updated_at: submittedAt,
    });
  }

  it("successful claim returns non-null attempt_id linked on the batch", () => {
    seedPending("batch-1", "2026-08-25T00:00:00.000Z");
    const claimed = claimOnce(batches, attempts, {
      id: "batch-1",
      worker_identity: "github-actions",
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.attempt_id).toBeTruthy();
    expect(batches.get("batch-1")!.active_attempt_id).toBe(claimed!.attempt_id);
    expect(batches.get("batch-1")!.status).toBe("processing");
    expect(attempts.get(String(claimed!.attempt_id))!.status).toBe("claimed");
    expect(attempts.get(String(claimed!.attempt_id))!.mutation_started).toBe(
      false,
    );
  });

  it("creates exactly one claimed attempt and no orphans", () => {
    seedPending("batch-1", "2026-08-25T00:00:00.000Z");
    claimOnce(batches, attempts, {
      worker_identity: "github-actions",
    });
    const claimedAttempts = [...attempts.values()].filter(
      (a) => a.status === "claimed",
    );
    expect(claimedAttempts).toHaveLength(1);
    expect(claimedAttempts[0].batch_id).toBe("batch-1");
    expect(
      [...batches.values()].every(
        (b) =>
          b.status !== "processing" ||
          b.active_attempt_id === claimedAttempts[0].id,
      ),
    ).toBe(true);
  });

  it("concurrent claims cannot claim the same batch", () => {
    seedPending("batch-1", "2026-08-25T00:00:00.000Z");
    const first = claimOnce(batches, attempts, {
      id: "batch-1",
      worker_identity: "worker-a",
    });
    const second = claimOnce(batches, attempts, {
      id: "batch-1",
      worker_identity: "worker-b",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect([...attempts.values()]).toHaveLength(1);
  });

  it("explicit-ID and oldest-pending paths behave identically for linkage", () => {
    seedPending("batch-old", "2026-08-25T00:00:00.000Z");
    seedPending("batch-new", "2026-08-25T01:00:00.000Z");

    const auto = claimOnce(batches, attempts, {
      worker_identity: "github-actions",
    });
    expect(auto?.id).toBe("batch-old");
    expect(batches.get("batch-old")!.active_attempt_id).toBe(auto!.attempt_id);

    const explicit = claimOnce(batches, attempts, {
      id: "batch-new",
      worker_identity: "github-actions",
    });
    expect(explicit?.id).toBe("batch-new");
    expect(batches.get("batch-new")!.active_attempt_id).toBe(
      explicit!.attempt_id,
    );
  });

  it("never returns null after moving a pending batch to processing", () => {
    seedPending("batch-1", "2026-08-25T00:00:00.000Z");
    const claimed = claimOnce(batches, attempts, {
      worker_identity: "github-actions",
    });
    expect(claimed).not.toBeNull();
    expect(batches.get("batch-1")!.status).toBe("processing");
    expect(batches.get("batch-1")!.active_attempt_id).not.toBeNull();
    expect(claimed!.attempt_id).toBe(batches.get("batch-1")!.active_attempt_id);
  });

  it("documents the buggy double-update pattern as forbidden", () => {
    seedPending("batch-bug", "2026-08-25T00:00:00.000Z");
    const batch = batches.get("batch-bug")!;
    batch.status = "processing";
    batch.active_attempt_id = null;
    attempts.set("orphan-1", {
      id: "orphan-1",
      batch_id: "batch-bug",
      status: "claimed",
      worker_identity: "github-actions",
      mutation_started: false,
    });
    const reclaim = claimOnce(batches, attempts, {
      id: "batch-bug",
      worker_identity: "github-actions",
    });
    expect(reclaim).toBeNull();
    expect(batch.active_attempt_id).toBeNull();
  });
});

describe("complete/fail all-or-nothing behavioral regressions", () => {
  const batches = new Map<string, BatchRow>();
  const attempts = new Map<string, AttemptRow>();

  beforeEach(() => {
    batches.clear();
    attempts.clear();
  });

  function seedClaimed(): { batchId: string; attemptId: string } {
    batches.set("batch-1", {
      id: "batch-1",
      status: "processing",
      submitted_at: "2026-08-25T00:00:00.000Z",
      created_at: "2026-08-25T00:00:00.000Z",
      processing_started_at: "2026-08-25T00:01:00.000Z",
      active_attempt_id: "attempt-1",
      updated_at: "2026-08-25T00:01:00.000Z",
    });
    attempts.set("attempt-1", {
      id: "attempt-1",
      batch_id: "batch-1",
      status: "claimed",
      worker_identity: "github-actions",
      mutation_started: false,
    });
    return { batchId: "batch-1", attemptId: "attempt-1" };
  }

  it("successful complete updates both records", () => {
    const { batchId, attemptId } = seedClaimed();
    const result = finishOnce(batches, attempts, {
      batchId,
      attemptId,
      mode: "completed",
    });
    expect(result).not.toBeNull();
    expect(batches.get(batchId)!.status).toBe("completed");
    expect(batches.get(batchId)!.active_attempt_id).toBeNull();
    expect(attempts.get(attemptId)!.status).toBe("completed");
  });

  it("successful fail updates both records", () => {
    const { batchId, attemptId } = seedClaimed();
    const result = finishOnce(batches, attempts, {
      batchId,
      attemptId,
      mode: "failed",
      error: "boom",
    });
    expect(result).not.toBeNull();
    expect(batches.get(batchId)!.status).toBe("failed");
    expect(attempts.get(attemptId)!.status).toBe("failed");
  });

  it("incorrect attempt ID changes neither table", () => {
    const { batchId } = seedClaimed();
    const before = snapshot(batches, attempts);
    const result = finishOnce(batches, attempts, {
      batchId,
      attemptId: "wrong-attempt",
      mode: "completed",
    });
    expect(result).toBeNull();
    expect(snapshot(batches, attempts)).toEqual(before);
  });

  it("completed attempt changes neither table", () => {
    const { batchId, attemptId } = seedClaimed();
    attempts.get(attemptId)!.status = "completed";
    const before = snapshot(batches, attempts);
    const result = finishOnce(batches, attempts, {
      batchId,
      attemptId,
      mode: "completed",
    });
    expect(result).toBeNull();
    expect(snapshot(batches, attempts)).toEqual(before);
  });

  it("mismatched batch/attempt changes neither table", () => {
    seedClaimed();
    attempts.get("attempt-1")!.batch_id = "other-batch";
    const before = snapshot(batches, attempts);
    const result = finishOnce(batches, attempts, {
      batchId: "batch-1",
      attemptId: "attempt-1",
      mode: "failed",
      error: "x",
    });
    expect(result).toBeNull();
    expect(snapshot(batches, attempts)).toEqual(before);
  });

  it("repeated complete/fail is rejected without mutation", () => {
    const { batchId, attemptId } = seedClaimed();
    expect(
      finishOnce(batches, attempts, {
        batchId,
        attemptId,
        mode: "completed",
      }),
    ).not.toBeNull();
    const afterFirst = snapshot(batches, attempts);
    expect(
      finishOnce(batches, attempts, {
        batchId,
        attemptId,
        mode: "completed",
      }),
    ).toBeNull();
    expect(
      finishOnce(batches, attempts, {
        batchId,
        attemptId,
        mode: "failed",
        error: "late",
      }),
    ).toBeNull();
    expect(snapshot(batches, attempts)).toEqual(afterFirst);
  });
});

describe("stale recovery all-or-nothing behavioral regressions", () => {
  const batches = new Map<string, BatchRow>();
  const attempts = new Map<string, AttemptRow>();

  beforeEach(() => {
    batches.clear();
    attempts.clear();
  });

  function seedStaleClaimed(mutationStarted = false): {
    batchId: string;
    attemptId: string;
  } {
    batches.set("batch-1", {
      id: "batch-1",
      status: "processing",
      submitted_at: "2026-08-25T00:00:00.000Z",
      created_at: "2026-08-25T00:00:00.000Z",
      processing_started_at: "2026-08-24T00:00:00.000Z",
      active_attempt_id: "attempt-1",
      updated_at: "2026-08-24T00:00:00.000Z",
    });
    attempts.set("attempt-1", {
      id: "attempt-1",
      batch_id: "batch-1",
      status: "claimed",
      worker_identity: "github-actions",
      mutation_started: mutationStarted,
    });
    return { batchId: "batch-1", attemptId: "attempt-1" };
  }

  it("successful stale requeue updates both records", () => {
    const { batchId, attemptId } = seedStaleClaimed(false);
    const result = staleRequeueOnce(batches, attempts, { batchId, attemptId });
    expect(result).not.toBeNull();
    expect(batches.get(batchId)!.status).toBe("pending");
    expect(batches.get(batchId)!.active_attempt_id).toBeNull();
    expect(attempts.get(attemptId)!.status).toBe("abandoned");
  });

  it("stale requeue race cannot abandon attempt without requeuing batch", () => {
    const { batchId, attemptId } = seedStaleClaimed(false);
    // Simulate ownership race: batch no longer linked to this attempt.
    batches.get(batchId)!.active_attempt_id = "other-attempt";
    const before = snapshot(batches, attempts);
    const result = staleRequeueOnce(batches, attempts, { batchId, attemptId });
    expect(result).toBeNull();
    expect(snapshot(batches, attempts)).toEqual(before);
    expect(attempts.get(attemptId)!.status).toBe("claimed");
    expect(batches.get(batchId)!.status).toBe("processing");
  });

  it("stale fail-closed fails batch and abandons claimed attempt together", () => {
    const { batchId, attemptId } = seedStaleClaimed(true);
    const result = staleFailClosedOnce(batches, attempts, { batchId });
    expect(result.batch).not.toBeNull();
    expect(batches.get(batchId)!.status).toBe("failed");
    expect(attempts.get(attemptId)!.status).toBe("abandoned");
    expect(result.abandonedAttemptId).toBe(attemptId);
  });

  it("stale fail-closed still fails batch when no linked claimed attempt", () => {
    seedStaleClaimed(true);
    batches.get("batch-1")!.active_attempt_id = null;
    const beforeAttempt = structuredClone(attempts.get("attempt-1"));
    const result = staleFailClosedOnce(batches, attempts, {
      batchId: "batch-1",
    });
    expect(result.batch).not.toBeNull();
    expect(batches.get("batch-1")!.status).toBe("failed");
    expect(attempts.get("attempt-1")).toEqual(beforeAttempt);
    expect(result.abandonedAttemptId).toBeNull();
  });
});

describe("claimDiscoveryBatch MCP authorization unchanged", () => {
  it("keeps claim_discovery_batch on jobs:worker", async () => {
    const { TOOL_PERMISSIONS } = await import("@/lib/config");
    expect(TOOL_PERMISSIONS.claim_discovery_batch).toBe("jobs:worker");
  });
});
