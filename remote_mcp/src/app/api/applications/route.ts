import { NextResponse } from "next/server";

import { listApplicationsPage, markApplied } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const page = await listApplicationsPage({
      status: url.searchParams.get("status") || undefined,
      interviewing: url.searchParams.get("interviewing") === "1",
      q: url.searchParams.get("q") || undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50,
      offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0,
    });
    return NextResponse.json({ ok: true, ...page });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list applications";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      posting_id?: string;
      application_url?: string;
      resume_version?: string;
      notes?: string;
      applied_at?: string;
    };
    if (!body.posting_id) {
      return NextResponse.json({ ok: false, error: "posting_id required" }, { status: 400 });
    }
    const result = await markApplied({
      postingId: body.posting_id,
      applicationUrl: body.application_url,
      resumeVersion: body.resume_version,
      notes: body.notes,
      appliedAt: body.applied_at,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark applied";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
