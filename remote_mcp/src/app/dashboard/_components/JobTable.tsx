import { SelectableJobTable } from "./SelectableJobTable";

export { Badge, JobBadges, formatDate } from "./job_format";
export { formatPythonRank as formatMatch } from "@/lib/dashboard/scores";

/** Make DB rows safe to pass to a client component (Dates, bigints). */
export function toClientJobs(jobs: Record<string, unknown>[]): Record<string, unknown>[] {
  return jobs.map((job) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(job)) {
      if (v instanceof Date) out[k] = v.toISOString();
      else if (typeof v === "bigint") out[k] = v.toString();
      else if (v !== null && typeof v === "object" && !Array.isArray(v)) out[k] = JSON.parse(JSON.stringify(v));
      else out[k] = v;
    }
    return out;
  });
}

export function JobTable({
  jobs,
  showActions = false,
  toolbar,
}: {
  jobs: Record<string, unknown>[];
  showActions?: boolean;
  toolbar?: React.ReactNode;
}) {
  return <SelectableJobTable jobs={toClientJobs(jobs)} showActions={showActions} toolbar={toolbar} />;
}
