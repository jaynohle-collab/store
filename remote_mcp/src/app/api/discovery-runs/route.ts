import { NextResponse } from "next/server";

import { withDashboardApi, parseSearchParams } from "@/lib/dashboard/api";
import { paginationSchema } from "@/lib/dashboard/validation";
import { listDiscoveryRunsPage } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const url = new URL(req.url);
    const parsed = parseSearchParams(paginationSchema, url);
    if ("response" in parsed) return parsed.response;

    const page = await listDiscoveryRunsPage(parsed.data.limit, parsed.data.offset);
    return NextResponse.json({ ok: true, ...page });
  });
}
