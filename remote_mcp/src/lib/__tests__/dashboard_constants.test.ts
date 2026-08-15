import { describe, expect, it } from "vitest";

import {
  APPLIED_OR_LATER_STATUSES,
  DEFAULT_HIGH_MATCH_THRESHOLD,
  INTERVIEW_STATUSES,
} from "@/lib/dashboard/constants";

describe("dashboard query definitions", () => {
  it("keeps to-apply policy thresholds configurable", () => {
    expect(DEFAULT_HIGH_MATCH_THRESHOLD).toBeGreaterThan(0);
  });

  it("defines interviewing and applied status sets without scoring", () => {
    expect(INTERVIEW_STATUSES).toContain("interview");
    expect(APPLIED_OR_LATER_STATUSES).toContain("applied");
    expect(APPLIED_OR_LATER_STATUSES).not.toContain("planned");
  });
});
