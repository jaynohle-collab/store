import { describe, expect, it } from "vitest";
import { z } from "zod";

import { saveJobPostingSchema } from "@/lib/db/lifecycle";
import { applyDiscoveryBatchJobPersistenceSchema } from "@/lib/db/discovery_batch_worker_apply";

describe("apply create_posting optional field contract", () => {
  const basePosting = {
    use_new_canonical: true,
    source: "Greenhouse",
    url: "https://example.com/jobs/staff-ai",
    normalized_url: "https://example.com/jobs/staff-ai",
    description: "Build agents.",
    posting_status: "active",
    is_repost: false,
  };

  it("rejects JSON null for optional create_posting fields (production failure shape)", () => {
    const result = applyDiscoveryBatchJobPersistenceSchema.safeParse({
      batch_id: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7",
      attempt_id: "d5c976c8-d2d2-4ac6-bb96-f0010d540c2b",
      input_index: 0,
      idempotency_key: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7:0",
      processing_action: "created",
      create_posting: {
        ...basePosting,
        external_job_id: null,
        posted_date: null,
        supersedes_posting_id: null,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "create_posting.external_job_id",
          "create_posting.posted_date",
          "create_posting.supersedes_posting_id",
        ]),
      );
    }
  });

  it("accepts omitted optional create_posting fields", () => {
    const result = applyDiscoveryBatchJobPersistenceSchema.safeParse({
      batch_id: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7",
      attempt_id: "d5c976c8-d2d2-4ac6-bb96-f0010d540c2b",
      input_index: 0,
      idempotency_key: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7:0",
      processing_action: "created",
      create_posting: basePosting,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid external_job_id, posted_date, and supersedes UUID", () => {
    const parsed = saveJobPostingSchema
      .omit({ canonical_job_id: true })
      .safeParse({
        ...basePosting,
        external_job_id: "gh-123",
        posted_date: "2026-08-16",
        supersedes_posting_id: "11111111-1111-4111-8111-111111111111",
      });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty-string posted_date and non-uuid supersedes", () => {
    expect(
      z
        .object({
          posted_date: saveJobPostingSchema.shape.posted_date,
          supersedes_posting_id: saveJobPostingSchema.shape.supersedes_posting_id,
        })
        .safeParse({
          posted_date: "",
          supersedes_posting_id: "not-a-uuid",
        }).success,
    ).toBe(false);
  });

  it("accepts YYYY-MM-DD and offset datetime; rejects naive datetime", () => {
    const posted = saveJobPostingSchema.shape.posted_date;
    expect(posted.safeParse("2026-08-16").success).toBe(true);
    expect(posted.safeParse("2026-08-16T12:00:00+00:00").success).toBe(true);
    expect(posted.safeParse("2026-08-16T12:00:00Z").success).toBe(true);
    expect(posted.safeParse("2026-08-16T12:00:00").success).toBe(false);
    expect(posted.safeParse("08/16/2026").success).toBe(false);
  });

  it("accepts evaluation.match_score of 0 and is_repost false", () => {
    const result = applyDiscoveryBatchJobPersistenceSchema.safeParse({
      batch_id: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7",
      attempt_id: "d5c976c8-d2d2-4ac6-bb96-f0010d540c2b",
      input_index: 0,
      idempotency_key: "8c6dd9fe-3abf-46b1-b0c5-1e646416cdc7:0",
      processing_action: "created",
      create_posting: {
        ...basePosting,
        is_repost: false,
      },
      evaluation: {
        use_resolved_posting: true,
        match_score: 0,
        recommendation: "save",
      },
    });
    expect(result.success).toBe(true);
  });
});
