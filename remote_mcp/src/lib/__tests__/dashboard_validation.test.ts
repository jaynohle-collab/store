import { describe, expect, it } from "vitest";

import { jobsQuerySchema, markAppliedBodySchema, uuidSchema } from "@/lib/dashboard/validation";

describe("dashboard Zod validation", () => {
  it("rejects invalid UUID", () => {
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("rejects invalid sort and oversized limit", () => {
    expect(jobsQuerySchema.safeParse({ sort: "nope" }).success).toBe(false);
    expect(jobsQuerySchema.safeParse({ limit: "999" }).success).toBe(false);
  });

  it("accepts valid jobs query defaults", () => {
    const parsed = jobsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sort).toBe("newest");
      expect(parsed.data.limit).toBe(50);
      expect(parsed.data.offset).toBe(0);
    }
  });

  it("requires posting_id UUID for mark applied", () => {
    expect(markAppliedBodySchema.safeParse({}).success).toBe(false);
    expect(
      markAppliedBodySchema.safeParse({
        posting_id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });
});
