import {
  getAutomaticDiscoveryStatus,
  listDiscoveryRunsPage,
} from "@/lib/db/dashboard";
import { formatDate } from "../_components/JobTable";

export const dynamic = "force-dynamic";

type AutoStatus = {
  latest_runs: Record<string, unknown>[];
  pending_batches: number;
  failed_batches: number;
  due_companies: number;
  failed_source_count: number;
  next_scheduled_scan: string | null;
};

function metricValue(metrics: unknown, key: string): string {
  if (!metrics || typeof metrics !== "object") return "—";
  const value = (metrics as Record<string, unknown>)[key];
  if (value == null) return "—";
  return String(value);
}

export default async function DiscoveryRunsPage() {
  let runs: Record<string, unknown>[] = [];
  let error: string | null = null;
  let autoStatus: AutoStatus | null = null;
  let autoError: string | null = null;

  try {
    const page = await listDiscoveryRunsPage(50, 0);
    runs = page.discovery_runs;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  try {
    autoStatus = (await getAutomaticDiscoveryStatus()) as AutoStatus;
  } catch (err) {
    autoError =
      err instanceof Error
        ? err.message
        : "Automatic discovery status unavailable (migration 010 may not be applied yet).";
  }

  const latestAuto = autoStatus?.latest_runs?.[0] ?? null;

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Discovery Runs</h1>
          <p>Daily counts: discovered / new / repost / duplicate.</p>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ marginTop: 0 }}>Automatic discovery</h2>
        {autoError ? (
          <p className="muted">{autoError}</p>
        ) : autoStatus ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
                gap: "0.75rem",
                marginBottom: "1rem",
              }}
            >
              <div>
                <div className="muted">Status</div>
                <div>{latestAuto ? String(latestAuto.status || "—") : "No runs yet"}</div>
              </div>
              <div>
                <div className="muted">Last started</div>
                <div>{formatDate(latestAuto?.started_at)}</div>
              </div>
              <div>
                <div className="muted">LLM provider</div>
                <div>{String(latestAuto?.llm_provider || "—")}</div>
              </div>
              <div>
                <div className="muted">Due companies</div>
                <div>{autoStatus.due_companies}</div>
              </div>
              <div>
                <div className="muted">Failed sources</div>
                <div>{autoStatus.failed_source_count}</div>
              </div>
              <div>
                <div className="muted">Pending batches</div>
                <div>{autoStatus.pending_batches}</div>
              </div>
              <div>
                <div className="muted">Failed batches</div>
                <div>{autoStatus.failed_batches}</div>
              </div>
              <div>
                <div className="muted">Next scan</div>
                <div>{formatDate(autoStatus.next_scheduled_scan)}</div>
              </div>
            </div>
            {latestAuto ? (
              <div className="muted" style={{ fontSize: "0.9rem" }}>
                Last run metrics — companies:{" "}
                {metricValue(latestAuto.metrics, "companies_scanned")}, candidates:{" "}
                {metricValue(latestAuto.metrics, "candidates_found")}, qualified:{" "}
                {metricValue(latestAuto.metrics, "qualified")}, submitted:{" "}
                {metricValue(latestAuto.metrics, "submitted")}, error:{" "}
                {String(latestAuto.error_summary || "—")}
              </div>
            ) : null}
            {autoStatus.latest_runs.length > 1 ? (
              <div className="table-wrap" style={{ marginTop: "1rem" }}>
                <table className="jobs">
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Status</th>
                      <th>Provider</th>
                      <th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {autoStatus.latest_runs.slice(0, 5).map((run) => (
                      <tr key={String(run.id)}>
                        <td>{formatDate(run.started_at)}</td>
                        <td>{String(run.status || "—")}</td>
                        <td>{String(run.llm_provider || "—")}</td>
                        <td>{formatDate(run.completed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {error ? <div className="panel muted">{error}</div> : null}
      {!runs.length && !error ? <div className="empty">No discovery runs recorded yet.</div> : null}
      {runs.length ? (
        <div className="table-wrap">
          <table className="jobs">
            <thead>
              <tr>
                <th>Started</th>
                <th>Source</th>
                <th>Discovered</th>
                <th>New</th>
                <th>Reposts</th>
                <th>Duplicates</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={String(run.id)}>
                  <td>{formatDate(run.started_at)}</td>
                  <td>{String(run.source || "—")}</td>
                  <td>{String(run.jobs_discovered ?? 0)}</td>
                  <td>{String(run.new_jobs ?? 0)}</td>
                  <td>{String(run.reposts ?? 0)}</td>
                  <td>{String(run.duplicates ?? 0)}</td>
                  <td>{formatDate(run.completed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
