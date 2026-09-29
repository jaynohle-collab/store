/** Automatic discovery run metrics shown on /dashboard/discovery. */

export type RunMetricLabel = {
  key: string;
  label: string;
  /** Older runs stored the same value under this key. */
  fallbackKey?: string;
};

export const RUN_METRIC_LABELS: RunMetricLabel[] = [
  { key: "pending_claimed", label: "Pending claimed" },
  { key: "pending_completed", label: "Pending completed" },
  { key: "pending_paused", label: "Pending paused" },
  { key: "companies_claimed", label: "Companies claimed" },
  { key: "companies_completed", label: "Completed" },
  { key: "companies_deferred", label: "Deferred" },
  { key: "companies_failed", label: "Failed" },
  { key: "listings_fetched", label: "Listings fetched", fallbackKey: "candidates_listed" },
  { key: "candidates_deterministic_rejected", label: "Rule rejected" },
  { key: "candidates_skipped", label: "Known / applied / duplicate" },
  { key: "candidates_ranked", label: "Ranked" },
  { key: "candidates_unchanged_skipped", label: "Unchanged" },
  { key: "candidates_below_threshold", label: "Below threshold" },
  { key: "candidates_selected", label: "Selected (top-K)" },
  { key: "full_descriptions_requested", label: "Full JDs fetched" },
  { key: "candidates_queued", label: "Candidates queued" },
  { key: "stored_reused", label: "Evidence reused" },
  { key: "candidates_evaluated", label: "New LLM evaluations" },
  { key: "evaluations_paused", label: "Evaluations paused" },
  { key: "provider_circuit_open", label: "Provider circuit open" },
  { key: "llm_calls", label: "LLM calls" },
  { key: "estimated_llm_tokens", label: "Est. tokens" },
  { key: "candidates_qualified", label: "Qualified" },
  { key: "candidates_rejected", label: "Rejected" },
  { key: "qualified_unsubmitted", label: "Qualified, unsubmitted" },
  { key: "batches_submitted", label: "Batches submitted" },
  { key: "jobs_submitted", label: "Jobs submitted" },
  { key: "pending_preserved", label: "Pending preserved" },
  { key: "listing_requests", label: "HTTP requests" },
  { key: "rate_limit_responses", label: "Rate limited" },
  { key: "http_retries", label: "HTTP retries" },
  { key: "bytes_downloaded", label: "Bytes downloaded" },
  { key: "duration_seconds", label: "Duration (s)" },
];

function asRecord(metrics: unknown): Record<string, unknown> | null {
  return metrics && typeof metrics === "object" && !Array.isArray(metrics)
    ? (metrics as Record<string, unknown>)
    : null;
}

export function metricValue(metrics: unknown, key: string): string {
  const record = asRecord(metrics);
  if (!record) return "—";
  const value = record[key];
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Label/value pairs present in a run's metrics; absent keys are omitted. */
export function selectRunMetrics(
  metrics: unknown,
): Array<{ key: string; label: string; value: string }> {
  const record = asRecord(metrics);
  if (!record) return [];
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const { key, label, fallbackKey } of RUN_METRIC_LABELS) {
    const source =
      record[key] != null ? key : fallbackKey && record[fallbackKey] != null ? fallbackKey : null;
    if (!source) continue;
    out.push({ key, label, value: metricValue(record, source) });
  }
  return out;
}
