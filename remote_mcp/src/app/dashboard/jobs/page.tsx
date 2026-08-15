import { listDashboardJobs } from "@/lib/db/dashboard";
import { JobTable } from "../_components/JobTable";
import { JobsSearchForm } from "../_components/JobsSearchForm";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AllJobsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const sort = (typeof sp.sort === "string" ? sp.sort : "newest") as
    | "newest"
    | "posted"
    | "match"
    | "company";
  const lifecycle = (typeof sp.lifecycle === "string" ? sp.lifecycle : undefined) as
    | "new"
    | "repost"
    | "all"
    | undefined;
  const offset = typeof sp.offset === "string" ? Number(sp.offset) : 0;

  let jobs: Record<string, unknown>[] = [];
  let nextOffset: number | null = null;
  let error: string | null = null;
  try {
    const page = await listDashboardJobs({
      q,
      sort,
      lifecycle: lifecycle === "all" ? undefined : lifecycle,
      limit: 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    jobs = page.jobs;
    nextOffset = page.nextOffset;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>All Jobs</h1>
          <p>Search company, title, posting URL, application URL, source, or external id.</p>
        </div>
      </div>
      <JobsSearchForm initialQ={q} initialSort={sort} initialLifecycle={lifecycle} />
      {error ? <div className="panel muted">{error}</div> : null}
      <JobTable jobs={jobs} />
      {nextOffset != null ? (
        <p style={{ marginTop: "1rem" }}>
          <a href={`/dashboard/jobs?q=${encodeURIComponent(q || "")}&sort=${sort}&offset=${nextOffset}`}>
            Next page →
          </a>
        </p>
      ) : null}
    </>
  );
}
