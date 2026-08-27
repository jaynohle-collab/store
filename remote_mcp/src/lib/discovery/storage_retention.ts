/**
 * Storage observability + description retention preview (dry-run only).
 * Never deletes rows — Milestone 5 prepares cleanup; production cleanup stays off.
 */

import { z } from "zod";

export const DEFAULT_DESCRIPTION_RETENTION_DAYS = 60;
export const STORAGE_WARNING_RATIO = 0.8;

/** Neon free tier common ceiling; treat as soft warning target, not a hard limit. */
export const DEFAULT_STORAGE_SOFT_LIMIT_BYTES = 512 * 1024 * 1024;

export const previewDescriptionRetentionSchema = z
  .object({
    older_than_days: z
      .number()
      .int()
      .min(7)
      .max(3650)
      .default(DEFAULT_DESCRIPTION_RETENTION_DAYS),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export type PreviewDescriptionRetentionInput = z.infer<
  typeof previewDescriptionRetentionSchema
>;

export type RetentionPreviewRow = {
  posting_id: string;
  description_bytes: number;
  last_seen_at: string | null;
  posting_status: string | null;
};

export function summarizeRetentionPreview(rows: RetentionPreviewRow[]): {
  candidate_count: number;
  reclaimable_description_bytes: number;
  note: string;
} {
  const reclaimable = rows.reduce(
    (sum, row) => sum + Math.max(0, row.description_bytes || 0),
    0,
  );
  return {
    candidate_count: rows.length,
    reclaimable_description_bytes: reclaimable,
    note:
      "Dry-run only. Active postings, application history, hashes, evaluations, " +
      "and provenance are never deleted by this preview.",
  };
}

export function storageWarningThresholdBytes(
  softLimitBytes: number = DEFAULT_STORAGE_SOFT_LIMIT_BYTES,
  ratio: number = STORAGE_WARNING_RATIO,
): number {
  return Math.floor(softLimitBytes * ratio);
}

export function isApproachingStorageLimit(
  usedBytes: number,
  softLimitBytes: number = DEFAULT_STORAGE_SOFT_LIMIT_BYTES,
): boolean {
  return usedBytes >= storageWarningThresholdBytes(softLimitBytes);
}
