import { listDashboardJobs } from "@/lib/db/dashboard";
import { JobTable } from "../_components/JobTable";

export const dynamic = "force-dynamic";

export default async function ToApplyPage() {
  let jobs: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const page = await listDashboardJobs({ toApply: true, limit: 100, sort: "match" });
    jobs = page.jobs;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>To Apply</h1>
          <p>
            Active postings with a save or save_repost recommendation and no application for
            this posting. Sorted by match score. Reposts are never auto-marked applied.
          </p>
        </div>
      </div>
      {error ? <div className="panel muted">{error}</div> : null}
      <JobTable jobs={jobs} showActions />
    </>
  );
}
