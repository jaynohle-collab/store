import { NextResponse } from "next/server";

import { withDashboardApi, parseSearchParams } from "@/lib/dashboard/api";
import { DEFAULT_HIGH_MATCH_THRESHOLD } from "@/lib/dashboard/constants";
import { summaryQuerySchema } from "@/lib/dashboard/validation";
import { getDashboardSummary } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const url = new URL(req.url);
    const parsed = parseSearchParams(summaryQuerySchema, url);
    if ("response" in parsed) return parsed.response;

    const threshold =
      parsed.data.threshold ?? DEFAULT_HIGH_MATCH_THRESHOLD;
    const summary = await getDashboardSummary(threshold);
    return NextResponse.json({ ok: true, summary });
  });
}
