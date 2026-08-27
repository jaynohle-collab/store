import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEASE_MS,
  MAX_BACKOFF_MS,
  SUCCESS_INTERVAL_MS,
  classifyHttpError,
  computeNextEligibleAt,
  failureBackoffMs,
  isLeaseStale,
  successIntervalMs,
} from "@/lib/discovery/company_schedule";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("company_schedule success intervals", () => {
  it("maps priorities to documented intervals", () => {
    expect(successIntervalMs("manual")).toBe(1 * HOUR_MS);
    expect(successIntervalMs("hot")).toBe(6 * HOUR_MS);
    expect(successIntervalMs("high")).toBe(24 * HOUR_MS);
    expect(successIntervalMs("normal")).toBe(5 * DAY_MS);
    expect(successIntervalMs("inactive")).toBe(30 * DAY_MS);
    expect(SUCCESS_INTERVAL_MS.hot).toBe(6 * HOUR_MS);
  });

  it("schedules next eligible from success using priority interval", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const next = computeNextEligibleAt({
      priority: "hot",
      now,
      success: true,
    });
    expect(next.toISOString()).toBe(
      new Date(now.getTime() + 6 * HOUR_MS).toISOString(),
    );
  });

  it("forceImmediate returns now; manual success still waits 1h", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    expect(
      computeNextEligibleAt({
        priority: "normal",
        now,
        forceImmediate: true,
      }).getTime(),
    ).toBe(now.getTime());
    expect(
      computeNextEligibleAt({ priority: "manual", now, success: true }).getTime(),
    ).toBe(now.getTime() + HOUR_MS);
  });
});

describe("company_schedule failure backoff", () => {
  it("uses exponential hours capped at 30 days", () => {
    expect(failureBackoffMs(1)).toBe(1 * HOUR_MS);
    expect(failureBackoffMs(2)).toBe(2 * HOUR_MS);
    expect(failureBackoffMs(3)).toBe(4 * HOUR_MS);
    expect(failureBackoffMs(4)).toBe(8 * HOUR_MS);
    expect(failureBackoffMs(10)).toBe(512 * HOUR_MS); // still under 30d
    expect(failureBackoffMs(11)).toBe(MAX_BACKOFF_MS); // 1024h capped
    expect(failureBackoffMs(0)).toBe(1 * HOUR_MS);
  });

  it("schedules next eligible from consecutive failures", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const next = computeNextEligibleAt({
      priority: "normal",
      now,
      success: false,
      consecutiveFailures: 3,
    });
    expect(next.toISOString()).toBe(
      new Date(now.getTime() + 4 * HOUR_MS).toISOString(),
    );
  });
});

describe("company_schedule lease staleness", () => {
  it("treats missing or past leases as stale", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    expect(isLeaseStale(null, now)).toBe(true);
    expect(isLeaseStale(undefined, now)).toBe(true);
    expect(isLeaseStale("not-a-date", now)).toBe(true);
    expect(isLeaseStale(new Date("2026-08-25T11:59:00.000Z"), now)).toBe(true);
    expect(isLeaseStale("2026-08-25T11:59:00.000Z", now)).toBe(true);
  });

  it("treats future leases as active", () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    expect(isLeaseStale(new Date(now.getTime() + DEFAULT_LEASE_MS), now)).toBe(
      false,
    );
    expect(isLeaseStale("2026-08-25T12:30:00.000Z", now)).toBe(false);
  });
});

describe("company_schedule HTTP error classification", () => {
  it("classifies common status codes", () => {
    expect(classifyHttpError(null)).toBe("network");
    expect(classifyHttpError(undefined)).toBe("network");
    expect(classifyHttpError(429)).toBe("rate_limit");
    expect(classifyHttpError(404)).toBe("not_found");
    expect(classifyHttpError(408)).toBe("timeout");
    expect(classifyHttpError(504)).toBe("timeout");
    expect(classifyHttpError(500)).toBe("server_error");
    expect(classifyHttpError(503)).toBe("server_error");
    expect(classifyHttpError(400)).toBe("validation");
    expect(classifyHttpError(422)).toBe("validation");
    expect(classifyHttpError(200)).toBe("unknown");
  });
});
