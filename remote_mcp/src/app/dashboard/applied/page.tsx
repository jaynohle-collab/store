import { AppliedToolbar } from "../_components/AppliedToolbar";
import { ApplicationsTable } from "../_components/ApplicationsTable";
import { DashboardPagination } from "../_components/DashboardPagination";
import type { PaginationMeta } from "@/lib/dashboard/query_params";
import {
  parseAppliedSort,
  parsePage,
  parsePageSize,
} from "@/lib/dashboard/query_params";
import { listApplicationsPage } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function spString(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  return typeof v === "string" ? v : undefined;
}

export default async function AppliedPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = spString(sp, "q");
  const sort = parseAppliedSort(spString(sp, "sort"));
  const page = parsePage(spString(sp, "page"));
  const pageSize = parsePageSize(spString(sp, "pageSize"));

  let apps: Record<string, unknown>[] = [];
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
    const result = await listApplicationsPage({
      q,
      sort,
      page,
      pageSize,
      appliedOnly: true,
      interviewing: false,
    });
    apps = result.applications;
    pagination = result.pagination;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  const query = { q, sort, pageSize };

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>Applied</h1>
          <p>Applications at applied status or later. Use Undo Applied to correct accidental marks.</p>
        </div>
      </div>
      <AppliedToolbar initialQ={q} initialSort={sort} initialPageSize={pageSize} />
      {error ? <div className="panel muted" role="alert">{error}</div> : null}
      <DashboardPagination basePath="/dashboard/applied" query={{ ...query, page }} pagination={pagination} />
      <ApplicationsTable apps={apps} showUndo />
      <DashboardPagination basePath="/dashboard/applied" query={{ ...query, page }} pagination={pagination} />
    </>
  );
}
