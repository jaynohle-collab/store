import { NextResponse } from "next/server";

import { withDashboardApi, parseSearchParams } from "@/lib/dashboard/api";
import { jobsQuerySchema } from "@/lib/dashboard/validation";
import { listDashboardJobs, type JobListFilters } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const url = new URL(req.url);
    const parsed = parseSearchParams(jobsQuerySchema, url);
    if ("response" in parsed) return parsed.response;

    const sp = parsed.data;
    const filters: JobListFilters = {
      q: sp.q,
      dateFrom: sp.date_from,
      dateTo: sp.date_to,
      minMatch: sp.min_match,
      applicationStatus: sp.application_status,
      lifecycle: sp.lifecycle,
      remoteStatus: sp.remote_status,
      company: sp.company,
      source: sp.source,
      toApply: sp.to_apply === "1",
      applied: sp.applied === "1",
      interviewing: sp.interviewing === "1",
      reposted: sp.reposted === "1",
      limit: sp.limit,
      offset: sp.offset,
      sort: sp.sort,
    };
    const page = await listDashboardJobs(filters);
    return NextResponse.json({ ok: true, ...page });
  });
}
