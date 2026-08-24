import { DashboardPagination } from "../_components/DashboardPagination";
import { JobTable } from "../_components/JobTable";
import { ToApplyToolbar } from "../_components/ToApplyToolbar";
import type { PaginationMeta } from "@/lib/dashboard/query_params";
import {
  parsePage,
  parsePageSize,
  parseRemoteFilter,
  parseToApplySort,
} from "@/lib/dashboard/query_params";
import { listToApplyJobs } from "@/lib/db/dashboard_to_apply";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function spString(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  return typeof v === "string" ? v : undefined;
}

export default async function ToApplyPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = spString(sp, "q");
  const sort = parseToApplySort(spString(sp, "sort"));
  const remote = parseRemoteFilter(spString(sp, "remote"));
  const page = parsePage(spString(sp, "page"));
  const pageSize = parsePageSize(spString(sp, "pageSize"));

  let jobs: Record<string, unknown>[] = [];
  let pagination: PaginationMeta = {
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 0,
    rangeStart: 0,
    rangeEnd: 0,
    hasPrevious: false,
    hasNext: false,
  };
  let error: string | null = null;

  try {
    const result = await listToApplyJobs({ q, sort, remote, page, pageSize });
    jobs = result.jobs;
    pagination = result.pagination;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  const query = { q, sort, remote, pageSize };

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>To Apply</h1>
          <p>
            Active postings with save or save_repost recommendations and no active application.
            Default view shows fully remote US nationwide roles only. Rank is Python profile-v1;
            GPT Fit is admission evidence — separate scores.
          </p>
        </div>
      </div>
      <ToApplyToolbar
        initialQ={q}
        initialSort={sort}
        initialRemote={remote}
        initialPageSize={pageSize}
      />
      {error ? <div className="panel muted" role="alert">{error}</div> : null}
      <DashboardPagination basePath="/dashboard/to-apply" query={{ ...query, page }} pagination={pagination} />
      <JobTable jobs={jobs} showActions />
      <DashboardPagination basePath="/dashboard/to-apply" query={{ ...query, page }} pagination={pagination} />
    </>
  );
}
