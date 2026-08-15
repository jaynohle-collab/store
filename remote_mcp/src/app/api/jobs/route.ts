import { NextResponse } from "next/server";

import { listDashboardJobs, type JobListFilters } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;
    const filters: JobListFilters = {
      q: sp.get("q") || undefined,
      dateFrom: sp.get("date_from") || undefined,
      dateTo: sp.get("date_to") || undefined,
      minMatch: sp.get("min_match") ? Number(sp.get("min_match")) : undefined,
      applicationStatus: sp.get("application_status") || undefined,
      lifecycle: (sp.get("lifecycle") as JobListFilters["lifecycle"]) || undefined,
      remoteStatus: sp.get("remote_status") || undefined,
      company: sp.get("company") || undefined,
      source: sp.get("source") || undefined,
      toApply: sp.get("to_apply") === "1",
      applied: sp.get("applied") === "1",
      interviewing: sp.get("interviewing") === "1",
      reposted: sp.get("reposted") === "1",
      limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
      offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
      sort: (sp.get("sort") as JobListFilters["sort"]) || "newest",
    };
    const page = await listDashboardJobs(filters);
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list jobs";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
