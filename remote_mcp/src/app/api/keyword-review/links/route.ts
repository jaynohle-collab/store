import { NextResponse } from "next/server";
import { requireDashboardApiUser, dashboardAuthErrorResponse } from "@/lib/dashboard/auth";
import { listKeywordReviewLinks } from "@/lib/db/keyword_review";
import { parseReviewFilters, reviewQuery, safeListingHref } from "@/app/dashboard/keyword-review/view";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireDashboardApiUser();
    let filters;
    try { filters = parseReviewFilters(Object.fromEntries(new URL(request.url).searchParams)); }
    catch { return NextResponse.json({ error: "Choose a valid collection date range." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
    const raw = await listKeywordReviewLinks({ ...reviewQuery(filters), offset: 0 });
    const links = [...new Set(raw.map(safeListingHref).filter((url): url is string => url !== null))];
    if (new TextEncoder().encode(links.join("\n")).length > 2_000_000) throw new Error("EXPORT_TOO_LARGE");
    return NextResponse.json({ links, skippedUnsafe: raw.filter(url => !safeListingHref(url)).length }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error); if (auth) return auth;
    const tooLarge = error instanceof Error && error.message === "EXPORT_TOO_LARGE";
    return NextResponse.json({ error: tooLarge ? "Export exceeds the safe copy size (20,000 results or 2 MB). Narrow the date range or search, then copy again. Nothing was copied." : "Could not load links. Try again. Nothing was copied." }, { status: tooLarge ? 413 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
