import { NextResponse } from "next/server";

import { listDiscoveryRunsPage } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 30;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
    const page = await listDiscoveryRunsPage(limit, offset);
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list discovery runs";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
