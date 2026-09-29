import { describe, expect, it } from "vitest";

import {
  RUN_METRIC_LABELS,
  metricValue,
  selectRunMetrics,
} from "@/lib/dashboard/run_metrics";

const OUTAGE_METRICS = [
  "pending_claimed",
  "pending_completed",
  "pending_paused",
  "companies_claimed",
  "listings_fetched",
  "candidates_queued",
  "evaluations_paused",
  "provider_circuit_open",
];

describe("automatic discovery run metrics", () => {
  it("labels every provider-outage metric exactly once", () => {
    const keys = RUN_METRIC_LABELS.map((m) => m.key);
    for (const key of OUTAGE_METRICS) {
      expect(keys.filter((k) => k === key)).toHaveLength(1);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(RUN_METRIC_LABELS.map((m) => m.label)).size).toBe(keys.length);
  });

  it("shows outage metrics from a partial provider-outage run", () => {
    const shown = selectRunMetrics({
      pending_claimed: 1,
      pending_completed: 0,
      pending_paused: 1,
      companies_claimed: 1,
      listings_fetched: 42,
      candidates_listed: 42,
      candidates_queued: 3,
      evaluations_paused: 4,
      provider_circuit_open: true,
      companies_failed: 0,
    });
    const byKey = Object.fromEntries(shown.map((m) => [m.key, m]));
    expect(byKey.pending_claimed.value).toBe("1");
    expect(byKey.pending_completed.value).toBe("0");
    expect(byKey.pending_paused.value).toBe("1");
    expect(byKey.companies_claimed.value).toBe("1");
    expect(byKey.listings_fetched).toMatchObject({ label: "Listings fetched", value: "42" });
    expect(byKey.candidates_queued.value).toBe("3");
    expect(byKey.evaluations_paused.value).toBe("4");
    expect(byKey.provider_circuit_open).toMatchObject({
      label: "Provider circuit open",
      value: "yes",
    });
    expect(byKey.companies_failed.value).toBe("0");
    expect(shown.filter((m) => m.label === "Listings fetched")).toHaveLength(1);
  });

  it("renders a closed circuit as no", () => {
    const shown = selectRunMetrics({ provider_circuit_open: false });
    expect(shown).toEqual([
      { key: "provider_circuit_open", label: "Provider circuit open", value: "no" },
    ]);
  });

  it("stays backward compatible with runs recorded before the new fields", () => {
    const shown = selectRunMetrics({
      companies_claimed: 3,
      candidates_listed: 792,
      candidates_selected: 5,
      pending_preserved: 5,
      paused_reason: "all_providers_unavailable:gemini 503",
    });
    const byKey = Object.fromEntries(shown.map((m) => [m.key, m.value]));
    expect(byKey).toEqual({
      companies_claimed: "3",
      listings_fetched: "792",
      candidates_selected: "5",
      pending_preserved: "5",
    });
    for (const key of OUTAGE_METRICS.filter(
      (k) => k !== "companies_claimed" && k !== "listings_fetched",
    )) {
      expect(byKey[key]).toBeUndefined();
    }
  });

  it("tolerates missing or malformed metrics", () => {
    expect(selectRunMetrics(null)).toEqual([]);
    expect(selectRunMetrics(undefined)).toEqual([]);
    expect(selectRunMetrics("oops")).toEqual([]);
    expect(selectRunMetrics([1, 2])).toEqual([]);
    expect(metricValue(null, "companies_claimed")).toBe("—");
    expect(metricValue({}, "companies_claimed")).toBe("—");
    expect(metricValue({ submitted: 0 }, "submitted")).toBe("0");
  });
});
