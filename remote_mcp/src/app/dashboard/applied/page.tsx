import { listApplicationsPage } from "@/lib/db/dashboard";
import { ApplicationsTable } from "../_components/ApplicationsTable";

export const dynamic = "force-dynamic";

export default async function AppliedPage() {
  let apps: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const page = await listApplicationsPage({ limit: 100 });
    apps = page.applications.filter((a) => {
      const s = String(a.status || "");
      return s !== "planned";
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Applied</h1>
          <p>Applications at applied status or later.</p>
        </div>
      </div>
      {error ? <div className="panel muted">{error}</div> : null}
      <ApplicationsTable apps={apps} />
    </>
  );
}
