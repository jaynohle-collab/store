import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveProfileVersion,
  getActiveScoringVersion,
  getLocalDayBounds,
  localMidnightToUtc,
} from "@/lib/dashboard/time";

describe("DASHBOARD_TIME_ZONE day boundaries", () => {
  afterEach(() => {
    delete process.env.DASHBOARD_TIME_ZONE;
  });

  it("computes America/Los_Angeles local midnight as an absolute UTC instant", () => {
    process.env.DASHBOARD_TIME_ZONE = "America/Los_Angeles";
    // 2026-01-15 00:00 PST = 2026-01-15 08:00 UTC
    const start = localMidnightToUtc("2026-01-15", "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("places a just-before-midnight Pacific instant on the previous local day", () => {
    process.env.DASHBOARD_TIME_ZONE = "America/Los_Angeles";
    // 2026-01-15 07:59:59 UTC is still 2026-01-14 23:59:59 PST
    const now = new Date("2026-01-15T07:59:59.000Z");
    const bounds = getLocalDayBounds("America/Los_Angeles", now);
    expect(bounds.localDate).toBe("2026-01-14");
    expect(bounds.start.toISOString()).toBe("2026-01-14T08:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("places a just-after-midnight Pacific instant on the new local day", () => {
    process.env.DASHBOARD_TIME_ZONE = "America/Los_Angeles";
    const now = new Date("2026-01-15T08:00:00.000Z");
    const bounds = getLocalDayBounds("America/Los_Angeles", now);
    expect(bounds.localDate).toBe("2026-01-15");
    expect(bounds.start.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("handles UTC timezone without relying on DB session TZ", () => {
    process.env.DASHBOARD_TIME_ZONE = "UTC";
    const now = new Date("2026-06-01T00:30:00.000Z");
    const bounds = getLocalDayBounds(undefined, now);
    expect(bounds.timeZone).toBe("UTC");
    expect(bounds.localDate).toBe("2026-06-01");
    expect(bounds.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });
});

describe("active scoring/profile versions", () => {
  beforeEach(() => {
    delete process.env.DASHBOARD_SCORING_VERSION;
    delete process.env.DASHBOARD_PROFILE_VERSION;
  });

  afterEach(() => {
    delete process.env.DASHBOARD_SCORING_VERSION;
    delete process.env.DASHBOARD_PROFILE_VERSION;
  });

  it("defaults to profile-v1 / jay-ai-v1", () => {
    expect(getActiveScoringVersion()).toBe("profile-v1");
    expect(getActiveProfileVersion()).toBe("jay-ai-v1");
  });

  it("reads configured active versions", () => {
    process.env.DASHBOARD_SCORING_VERSION = "simple-v2";
    process.env.DASHBOARD_PROFILE_VERSION = "profile-b";
    expect(getActiveScoringVersion()).toBe("simple-v2");
    expect(getActiveProfileVersion()).toBe("profile-b");
  });
});
