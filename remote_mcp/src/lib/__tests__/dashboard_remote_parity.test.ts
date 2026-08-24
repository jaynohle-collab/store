import { describe, expect, it } from "vitest";

import {
  classifyLegacyRemoteUsNationwide,
  isRemoteUsNationwideEligible,
} from "@/lib/dashboard/remote_eligibility";
import {
  matchesLegacyRemoteUsSqlLogic,
  matchesRemoteUsDashboardFilter,
} from "@/lib/dashboard/remote_eligibility_spec";

describe("remote SQL / TypeScript parity", () => {
  const includedLegacy = [
    {
      remote_status: "Remote",
      location: "Remote - United States",
    },
    {
      remote_status: "Remote",
      location: "United States - Remote",
    },
    {
      remote_status: "Remote",
      location: "US Remote",
    },
    {
      remote_status: "Remote",
      location: "Remote, USA",
    },
    {
      remote_status: "Remote",
      location: "Nationwide US",
    },
  ] as const;

  const excludedLegacy = [
    { remote_status: "Remote", location: "Remote" },
    { remote_status: "Remote", location: "Remote - CA" },
    { remote_status: "Remote", location: "Remote in New York" },
    { remote_status: "Remote", location: "USA, California, Remote" },
    { remote_status: "Remote", location: "Remote, Eastern Time only" },
    { remote_status: "Remote", location: "Remote, selected states" },
    { remote_status: "Hybrid", location: "United States" },
    { remote_status: "Onsite", location: "United States" },
    { remote_status: "Remote", location: "Canada Remote" },
    { remote_status: "Remote", location: "Americas Remote" },
    { remote_status: "Remote", location: "US except specific states" },
    { remote_status: "Remote", location: "" },
  ] as const;

  it.each(includedLegacy)("legacy included: %o", (input) => {
    expect(matchesLegacyRemoteUsSqlLogic(input.remote_status, input.location)).toBe(true);
    expect(classifyLegacyRemoteUsNationwide(input)).toBe(true);
  });

  it.each(excludedLegacy)("legacy excluded: %o", (input) => {
    expect(matchesLegacyRemoteUsSqlLogic(input.remote_status, input.location)).toBe(false);
    expect(classifyLegacyRemoteUsNationwide(input)).toBe(false);
  });

  it("includes v2 US_NATIONWIDE and excludes every other v2 remote_scope", () => {
    expect(
      matchesRemoteUsDashboardFilter({
        remote_scope: "US_NATIONWIDE",
        gpt_evaluation_id: "gpt-1",
        remote_status: "Remote",
        location: "Remote",
      }),
    ).toBe(true);
    expect(isRemoteUsNationwideEligible({ remote_scope: "US_NATIONWIDE" })).toBe(true);

    for (const scope of ["US_RESTRICTED", "HYBRID", "ONSITE", "NON_US", "UNKNOWN"] as const) {
      expect(
        matchesRemoteUsDashboardFilter({
          remote_scope: scope,
          gpt_evaluation_id: "gpt-1",
          remote_status: "Remote",
          location: "United States",
        }),
      ).toBe(false);
      expect(isRemoteUsNationwideEligible({ remote_scope: scope })).toBe(false);
    }
  });

  it("uses legacy inference only when v2 evidence is absent or scope is null", () => {
    expect(
      matchesRemoteUsDashboardFilter({
        remote_scope: null,
        gpt_evaluation_id: "gpt-v1",
        remote_status: "Remote",
        location: "United States - Remote",
      }),
    ).toBe(true);

    expect(
      matchesRemoteUsDashboardFilter({
        remote_scope: "HYBRID",
        gpt_evaluation_id: "gpt-v2",
        remote_status: "Remote",
        location: "United States - Remote",
      }),
    ).toBe(false);
  });

  it("does not let v1 evidence block legacy when remote_scope is null", () => {
    expect(
      isRemoteUsNationwideEligible({
        remote_scope: null,
        gpt_evaluation_id: "legacy-v1",
        remote_status: "Remote",
        location: "Remote, USA",
      }),
    ).toBe(true);
  });
});
