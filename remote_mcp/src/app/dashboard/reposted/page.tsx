import { listDashboardJobs } from "@/lib/db/dashboard";
import { JobTable } from "../_components/JobTable";

export const dynamic = "force-dynamic";

export default async function RepostedPage() {
  let jobs: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const page = await listDashboardJobs({ reposted: true, limit: 100, sort: "newest" });
    jobs = page.jobs;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Reposted</h1>
          <p>
            New posting occurrences linked to an existing canonical role. Prior applications on
            older postings are shown as Previously applied — the repost stays unapplied until you
            act.
          </p>
        </div>
      </div>
      {error ? <div className="panel muted">{error}</div> : null}
      <JobTable jobs={jobs} showActions />
    </>
  );
}
