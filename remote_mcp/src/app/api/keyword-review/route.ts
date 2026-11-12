import { NextResponse } from "next/server";
import { withDashboardApi, parseSearchParams } from "@/lib/dashboard/api";
import { listKeywordReviewCandidatesSchema } from "@/lib/discovery/keyword_review";
import { listKeywordReviewCandidates } from "@/lib/db/keyword_review";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const parsed = parseSearchParams(listKeywordReviewCandidatesSchema, new URL(req.url));
    if ("response" in parsed) return parsed.response;
    const page = await listKeywordReviewCandidates(parsed.data);
    return NextResponse.json({ ok: true, ...page }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
