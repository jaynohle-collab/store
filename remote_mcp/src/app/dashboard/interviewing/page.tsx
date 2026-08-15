import { listApplicationsPage } from "@/lib/db/dashboard";
import { ApplicationsTable } from "../_components/ApplicationsTable";

export const dynamic = "force-dynamic";

export default async function InterviewingPage() {
  let apps: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const page = await listApplicationsPage({ interviewing: true, limit: 100 });
    apps = page.applications;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Interviewing</h1>
          <p>Recruiter screen, technical screen, interview, or onsite.</p>
        </div>
      </div>
      {error ? <div className="panel muted">{error}</div> : null}
      <ApplicationsTable apps={apps} />
    </>
  );
}
