import { NextResponse } from "next/server";

import { DEFAULT_HIGH_MATCH_THRESHOLD } from "@/lib/dashboard/constants";
import { getDashboardSummary } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const thresholdParam = url.searchParams.get("threshold");
    const threshold = thresholdParam
      ? Number(thresholdParam)
      : DEFAULT_HIGH_MATCH_THRESHOLD;
    const summary = await getDashboardSummary(
      Number.isFinite(threshold) ? threshold : DEFAULT_HIGH_MATCH_THRESHOLD,
    );
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load summary";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
