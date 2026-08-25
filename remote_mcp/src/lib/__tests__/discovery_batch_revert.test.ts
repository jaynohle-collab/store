import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  batches,
  effectsByBatch,
  postings,
  applications,
  otherBatchPostingRefs,
  revertEvents,
  counters,
  txGate,
} = vi.hoisted(() => ({
  batches: new Map<string, Record<string, unknown>>(),
  effectsByBatch: new Map<string, Record<string, unknown>[]>(),
  postings: new Map<string, Record<string, unknown>>(),
  applications: new Map<string, Record<string, unknown>[]>(),
  otherBatchPostingRefs: new Set<string>(),
  revertEvents: [] as Record<string, unknown>[],
  counters: { transactionCalls: 0 },
  txGate: { available: true },
}));

vi.mock("@/lib/db/client", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("UPDATE job_postings")) {
      for (const value of values) {
        if (typeof value === "string" && postings.has(value)) {
          const current = postings.get(value)!;
          if (text.includes("withdrawn")) {
            current.posting_status = "withdrawn";
          } else if (text.includes("description_hash")) {
            const maybeStatus = values.find(
              (item) =>
                item === "active" || item === "withdrawn" || item === "closed",
            );
            if (typeof maybeStatus === "string") {
              current.posting_status = maybeStatus;
            }
          }
          return Promise.resolve([current]);
        }
      }
      return Promise.resolve([]);
    }
    if (text.includes("UPDATE discovery_inbox_batches") && text.includes("reverted")) {
      const id = String(values[0]);
      const batch = batches.get(id);
      if (!batch || !["completed", "failed"].includes(String(batch.status))) {
        return Promise.resolve([]);
      }
      batch.status = "reverted";
      return Promise.resolve([{ id }]);
    }
    if (text.includes("INSERT INTO discovery_batch_revert_events")) {
      const batchId = String(values[0]);
      const previewHash = String(values[1]);
      const requestedBy = (values[2] as string | null) ?? null;
      const summary = JSON.parse(String(values[3] ?? "{}")) as Record<
        string,
        unknown
      >;
      const compensated = (values[4] as string[]) ?? [];
      const protectedIds = (values[5] as string[]) ?? [];
      const idempotencyKey = String(values[6]);
      const existing = revertEvents.find(
        (event) =>
          event.batch_id === batchId && event.idempotency_key === idempotencyKey,
      );
      if (existing) return Promise.resolve([]);
      const row = {
        id: `revert-${revertEvents.length + 1}`,
        batch_id: batchId,
        preview_hash: previewHash,
        requested_by: requestedBy,
        result_summary: summary,
        compensated_effect_ids: compensated,
        protected_effect_ids: protectedIds,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      };
      revertEvents.push(row);
      return Promise.resolve([row]);
    }
    if (text.includes("FROM job_postings") && text.includes("WHERE id")) {
      const id = String(values[0]);
      const row = postings.get(id);
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes("FROM applications") && text.includes("posting_id")) {
      const id = String(values[0]);
      return Promise.resolve(applications.get(id) ?? []);
    }
    if (
      text.includes("FROM discovery_batch_effects") &&
      text.includes("batch_id <>")
    ) {
      const postingId = String(values[0]);
      return Promise.resolve(
        otherBatchPostingRefs.has(postingId) ? [{ "?column?": 1 }] : [],
      );
    }
    return Promise.resolve([]);
  };
  (sql as { transaction?: unknown }).transaction = async (
    statements: Array<Promise<unknown> | unknown>,
  ) => {
    if (!txGate.available) {
      throw new Error("neon_transaction_unavailable");
    }
    counters.transactionCalls += 1;
    const results = [];
    for (const statement of statements) {
      results.push(await statement);
    }
    return results;
  };
  return {
    getSql: () => sql,
    getTransactionalSql: () => {
      if (!txGate.available) {
        throw new Error(
          "neon_transaction_unavailable: refusing destructive multi-statement work without sql.transaction",
        );
      }
      return sql;
    },
    resetSqlClient: () => undefined,
  };
});

vi.mock("@/lib/db/inbox", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/inbox")>(
    "@/lib/db/inbox",
  );
  return {
    ...actual,
    getDiscoveryBatch: vi.fn(async (id: string) => {
      const row = batches.get(id);
      return row ? structuredClone(row) : null;
    }),
  };
});

vi.mock("@/lib/db/discovery_batch_provenance", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/discovery_batch_provenance")
  >("@/lib/db/discovery_batch_provenance");
  return {
    ...actual,
    listDiscoveryBatchEffects: vi.fn(async (batchId: string) =>
      structuredClone(effectsByBatch.get(batchId) ?? []),
    ),
    getLatestRevertEvent: vi.fn(async (batchId: string) => {
      const found = [...revertEvents]
        .reverse()
        .find((event) => event.batch_id === batchId);
      return found ? structuredClone(found) : null;
    }),
    getRevertEventByIdempotencyKey: vi.fn(
      async (batchId: string, key: string) => {
        const found = revertEvents.find(
          (event) =>
            event.batch_id === batchId && event.idempotency_key === key,
        );
        return found ? structuredClone(found) : null;
      },
    ),
  };
});

import { fingerprintPostingState } from "@/lib/db/discovery_batch_provenance";
import {
  previewDiscoveryBatchRevert,
  revertDiscoveryBatch,
} from "@/lib/db/discovery_batch_revert";

describe("discovery batch revert preview and compensation", () => {
  const batchId = "11111111-1111-4111-8111-111111111111";
  const postingId = "22222222-2222-4222-8222-222222222222";
  const effectId = "33333333-3333-4333-8333-333333333333";
  const canonicalId = "44444444-4444-4444-8444-444444444444";

  beforeEach(() => {
    batches.clear();
    effectsByBatch.clear();
    postings.clear();
    applications.clear();
    otherBatchPostingRefs.clear();
    revertEvents.length = 0;
    counters.transactionCalls = 0;
    txGate.available = true;
    vi.clearAllMocks();
  });

  function seedCreatedBatch(status = "completed") {
    const after = {
      id: postingId,
      canonical_job_id: canonicalId,
      posting_status: "active",
      description_hash: "abcdef0123456789",
      normalized_url: "https://example.com/jobs/1",
      location: "US",
      remote_status: "Remote",
      salary: "$1",
      url: "https://example.com/jobs/1",
      last_seen_at: "2026-08-24T00:02:00.000Z",
      is_repost: false,
    };
    batches.set(batchId, {
      id: batchId,
      source: "chatgpt",
      status,
      job_count: 1,
      payload: { jobs: [{ url: after.url }] },
      submitted_at: "2026-08-24T00:00:00.000Z",
      processing_started_at: "2026-08-24T00:01:00.000Z",
      processed_at: "2026-08-24T00:02:00.000Z",
      error: null,
    });
    postings.set(postingId, { ...after });
    applications.set(postingId, []);
    effectsByBatch.set(batchId, [
      {
        id: effectId,
        batch_id: batchId,
        input_index: 0,
        processing_action: "created",
        created_canonical: true,
        created_posting: true,
        canonical_job_id: canonicalId,
        posting_id: postingId,
        before_state: null,
        after_state: after,
        after_fingerprint: fingerprintPostingState(after),
      },
    ]);
  }

  it("preview performs no writes", async () => {
    seedCreatedBatch();
    const beforeBatch = structuredClone(batches.get(batchId));
    const beforeEffects = structuredClone(effectsByBatch.get(batchId));
    const beforePosting = structuredClone(postings.get(postingId));
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(true);
    expect(preview.preview_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(batches.get(batchId)).toEqual(beforeBatch);
    expect(effectsByBatch.get(batchId)).toEqual(beforeEffects);
    expect(postings.get(postingId)).toEqual(beforePosting);
    expect(revertEvents).toHaveLength(0);
  });

  it("valid preview followed by revert withdraws created posting", async () => {
    seedCreatedBatch();
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(true);
    const result = await revertDiscoveryBatch({
      batch_id: batchId,
      preview_hash: preview.preview_hash,
      requested_by: "unit-test",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("reverted");
    expect(result.withdrawn_postings).toContain(postingId);
    expect(batches.get(batchId)?.status).toBe("reverted");
    expect(postings.get(postingId)?.posting_status).toBe("withdrawn");
    expect(revertEvents).toHaveLength(1);
  });

  it("stale preview hash is rejected", async () => {
    seedCreatedBatch();
    await expect(
      revertDiscoveryBatch({
        batch_id: batchId,
        preview_hash: "0".repeat(64),
      }),
    ).rejects.toThrow(/stale_or_mismatched_preview_hash/);
  });

  it("application-protected job rejects entire revert", async () => {
    seedCreatedBatch();
    applications.set(postingId, [
      { id: "app-1", posting_id: postingId, status: "applied" },
    ]);
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(preview.blocking_reasons).toContain(
      "partially_protected_batch_rejected",
    );
    expect(
      preview.protected_applications.some((row) => row.status === "applied"),
    ).toBe(true);
  });

  it("interview-stage job rejects entire revert", async () => {
    seedCreatedBatch();
    applications.set(postingId, [
      { id: "app-2", posting_id: postingId, status: "interviewing" },
    ]);
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(
      preview.protected_applications.some(
        (row) => row.status === "interviewing",
      ),
    ).toBe(true);
  });

  it("cross-batch posting reference is protected", async () => {
    seedCreatedBatch();
    otherBatchPostingRefs.add(postingId);
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(
      preview.effects[0]?.protection_reasons.includes(
        "posting_referenced_by_another_batch",
      ),
    ).toBe(true);
  });

  it("legacy batch without provenance is not revertible", async () => {
    batches.set(batchId, {
      id: batchId,
      source: "chatgpt",
      status: "completed",
      job_count: 1,
    });
    effectsByBatch.set(batchId, []);
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(preview.blocking_reasons).toContain(
      "legacy_provenance_unavailable",
    );
  });

  it("pending and processing batches are not revertible", async () => {
    for (const status of ["pending", "processing"] as const) {
      batches.set(batchId, { id: batchId, status, source: "chatgpt", job_count: 0 });
      effectsByBatch.set(batchId, []);
      const preview = await previewDiscoveryBatchRevert(batchId);
      expect(preview.revertible).toBe(false);
      expect(preview.blocking_reasons.length).toBeGreaterThan(0);
    }
  });

  it("unknown batch is not revertible", async () => {
    const preview = await previewDiscoveryBatchRevert(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(preview.revertible).toBe(false);
    expect(preview.blocking_reasons).toContain("unknown_batch");
  });

  it("repeated identical revert is idempotent", async () => {
    seedCreatedBatch();
    const preview = await previewDiscoveryBatchRevert(batchId);
    const first = await revertDiscoveryBatch({
      batch_id: batchId,
      preview_hash: preview.preview_hash,
    });
    const second = await revertDiscoveryBatch({
      batch_id: batchId,
      preview_hash: preview.preview_hash,
    });
    expect(first.idempotent_replay).toBe(false);
    expect(second.idempotent_replay).toBe(true);
    expect(revertEvents).toHaveLength(1);
  });

  it("posting changed after preview blocks revertibility", async () => {
    seedCreatedBatch();
    const posting = postings.get(postingId)!;
    posting.description_hash = "changedhash000001";
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(
      preview.effects[0]?.protection_reasons.includes(
        "posting_changed_since_batch",
      ),
    ).toBe(true);
  });

  it("any application presence rejects entire revert", async () => {
    seedCreatedBatch();
    applications.set(postingId, [
      { id: "app-planned", posting_id: postingId, status: "planned" },
    ]);
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(false);
    expect(preview.blocking_reasons).toContain(
      "partially_protected_batch_rejected",
    );
    expect(
      preview.effects[0]?.protection_reasons.some((reason) =>
        reason.startsWith("application_present:"),
      ),
    ).toBe(true);
  });

  it("transaction unavailability rejects revert before mutations", async () => {
    seedCreatedBatch();
    const preview = await previewDiscoveryBatchRevert(batchId);
    expect(preview.revertible).toBe(true);
    txGate.available = false;
    await expect(
      revertDiscoveryBatch({
        batch_id: batchId,
        preview_hash: preview.preview_hash,
      }),
    ).rejects.toThrow(/neon_transaction_unavailable/);
    expect(batches.get(batchId)?.status).toBe("completed");
    expect(postings.get(postingId)?.posting_status).toBe("active");
    expect(revertEvents).toHaveLength(0);
    expect(counters.transactionCalls).toBe(0);
  });
});
