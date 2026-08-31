import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESCRIPTION_RETENTION_DAYS,
  DEFAULT_STORAGE_SOFT_LIMIT_BYTES,
  STORAGE_WARNING_RATIO,
  isApproachingStorageLimit,
  summarizeRetentionPreview,
  storageWarningThresholdBytes,
} from "@/lib/discovery/storage_retention";

describe("storage_retention preview summarize", () => {
  it("sums reclaimable description bytes and documents dry-run", () => {
    const summary = summarizeRetentionPreview([
      {
        posting_id: "a",
        description_bytes: 100,
        last_seen_at: "2026-01-01T00:00:00.000Z",
        posting_status: "closed",
      },
      {
        posting_id: "b",
        description_bytes: 250,
        last_seen_at: null,
        posting_status: "withdrawn",
      },
      {
        posting_id: "c",
        description_bytes: -5,
        last_seen_at: null,
        posting_status: null,
      },
    ]);
    expect(summary.candidate_count).toBe(3);
    expect(summary.reclaimable_description_bytes).toBe(350);
    expect(summary.note).toMatch(/Dry-run only/i);
    expect(summary.note).toMatch(/never deleted/i);
  });

  it("handles empty preview rows", () => {
    const summary = summarizeRetentionPreview([]);
    expect(summary.candidate_count).toBe(0);
    expect(summary.reclaimable_description_bytes).toBe(0);
  });

  it("keeps default retention day constant at 60", () => {
    expect(DEFAULT_DESCRIPTION_RETENTION_DAYS).toBe(60);
  });
});

describe("storage_retention warning threshold", () => {
  it("uses 80% of the soft limit by default", () => {
    expect(STORAGE_WARNING_RATIO).toBe(0.8);
    expect(storageWarningThresholdBytes()).toBe(
      Math.floor(DEFAULT_STORAGE_SOFT_LIMIT_BYTES * 0.8),
    );
    expect(storageWarningThresholdBytes(1_000_000, 0.5)).toBe(500_000);
  });

  it("flags approaching limit at or above the warning threshold", () => {
    const soft = 1_000_000;
    const warn = storageWarningThresholdBytes(soft);
    expect(isApproachingStorageLimit(warn - 1, soft)).toBe(false);
    expect(isApproachingStorageLimit(warn, soft)).toBe(true);
    expect(isApproachingStorageLimit(soft, soft)).toBe(true);
  });
});
