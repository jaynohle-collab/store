import { describe, expect, it } from "vitest";

import {
  APPLIED_OR_LATER_STATUSES,
  DEFAULT_HIGH_MATCH_THRESHOLD,
  INTERVIEW_STATUSES,
  TO_APPLY_RECOMMENDATIONS,
} from "@/lib/dashboard/constants";

describe("dashboard query definitions", () => {
  it("keeps High Match threshold at 70 (not To Apply gating)", () => {
    expect(DEFAULT_HIGH_MATCH_THRESHOLD).toBe(70);
  });

  it("defines To Apply via save / save_repost recommendations", () => {
    expect(TO_APPLY_RECOMMENDATIONS).toEqual(["save", "save_repost"]);
  });

  it("defines interviewing and applied status sets without scoring", () => {
    expect(INTERVIEW_STATUSES).toContain("interview");
    expect(APPLIED_OR_LATER_STATUSES).toContain("applied");
    expect(APPLIED_OR_LATER_STATUSES).not.toContain("planned");
  });
});
