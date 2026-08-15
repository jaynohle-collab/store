import Link from "next/link";

import { getDashboardSummary, listDashboardJobs } from "@/lib/db/dashboard";
import { DEFAULT_HIGH_MATCH_THRESHOLD } from "@/lib/dashboard/constants";
import { JobTable } from "./_components/JobTable";

export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
  let summary = null;
  let recent: Record<string, unknown>[] = [];
  let error: string | null = null;

  try {
    summary = await getDashboardSummary(DEFAULT_HIGH_MATCH_THRESHOLD);
    const page = await listDashboardJobs({ limit: 25, sort: "newest" });
    recent = page.jobs;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load dashboard";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Overview</h1>
          <p>Personal job-search control center</p>
        </div>
        <Link className="btn" href="/dashboard/to-apply">
          Go to To Apply
        </Link>
      </div>

      {error ? (
        <div className="panel">
          <p className="muted">
            Dashboard data unavailable ({error}). Ensure DATABASE_URL is set and migration
            004 is applied.
          </p>
        </div>
      ) : null}

      {summary ? (
        <div className="metric-grid">
          <Metric label="Discovered Today" value={summary.discovered_today} />
          <Metric label="New Today" value={summary.new_today} />
          <Metric label="High Match" value={summary.high_match_today} />
          <Metric label="To Apply" value={summary.to_apply} href="/dashboard/to-apply" />
          <Metric label="Applied" value={summary.applied} href="/dashboard/applied" />
          <Metric
            label="Interviewing"
            value={summary.interviewing}
            href="/dashboard/interviewing"
          />
          <Metric label="Reposted Today" value={summary.reposts_today} href="/dashboard/reposted" />
        </div>
      ) : null}

      <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Recently discovered</h2>
      <JobTable jobs={recent} />
    </>
  );
}

function Metric({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const inner = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="metric-card" style={{ color: "inherit", textDecoration: "none" }}>
        {inner}
      </Link>
    );
  }
  return <div className="metric-card">{inner}</div>;
}
