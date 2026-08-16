import { listDiscoveryRunsPage } from "@/lib/db/dashboard";
import { formatDate } from "../_components/JobTable";

export const dynamic = "force-dynamic";

export default async function DiscoveryRunsPage() {
  let runs: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const page = await listDiscoveryRunsPage(50, 0);
    runs = page.discovery_runs;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Discovery Runs</h1>
          <p>Daily counts: discovered / new / repost / duplicate.</p>
        </div>
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
