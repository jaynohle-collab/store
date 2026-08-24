import { describe, expect, it } from "vitest";

import {
  classifyLegacyRemoteUsNationwide,
  isRemoteUsNationwideEligible,
} from "@/lib/dashboard/remote_eligibility";

describe("remote US nationwide eligibility", () => {
  it("includes strict v2 US_NATIONWIDE evidence", () => {
    expect(
      isRemoteUsNationwideEligible({
        remote_scope: "US_NATIONWIDE",
        remote_status: "Remote",
        location: "United States",
      }),
    ).toBe(true);
  });

  it.each(["HYBRID", "US_RESTRICTED", "NON_US", "UNKNOWN"] as const)(
    "excludes v2 remote_scope %s",
    (scope) => {
      expect(
        isRemoteUsNationwideEligible({
          remote_scope: scope,
          remote_status: "Remote",
          location: "United States",
        }),
      ).toBe(false);
    },
  );

  it("excludes hybrid and onsite legacy roles", () => {
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Hybrid",
        location: "United States",
      }),
    ).toBe(false);
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "Hybrid — Seattle, WA",
      }),
    ).toBe(false);
  });

  it("excludes US-restricted remote and non-US locations", () => {
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "Remote in California only",
      }),
    ).toBe(false);
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "Canada (Remote)",
      }),
    ).toBe(false);
  });

  it("includes conservative legacy nationwide remote US", () => {
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "United States (Remote)",
      }),
    ).toBe(true);
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Fully remote",
        location: "USA",
      }),
    ).toBe(true);
  });

  it("does not treat United States with state restriction as nationwide", () => {
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "Remote — United States (California only)",
      }),
    ).toBe(false);
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "New York, NY — Remote within state",
      }),
    ).toBe(false);
  });

  it("hides ambiguous legacy remote from default view", () => {
    expect(
      classifyLegacyRemoteUsNationwide({
        remote_status: "Remote",
        location: "Remote",
      }),
    ).toBe(false);
  });
});
