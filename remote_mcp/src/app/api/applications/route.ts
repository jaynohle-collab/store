import { NextResponse } from "next/server";
import { z } from "zod";

import { withDashboardApi, parseSearchParams, zodBadRequest } from "@/lib/dashboard/api";
import { markAppliedBodySchema, paginationSchema } from "@/lib/dashboard/validation";
import { listApplicationsPage, markApplied } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

const applicationsQuerySchema = paginationSchema.extend({
  status: z.string().max(64).optional(),
  interviewing: z.enum(["0", "1"]).optional(),
  q: z.string().max(512).optional(),
});

export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const url = new URL(req.url);
    const parsed = parseSearchParams(applicationsQuerySchema, url);
    if ("response" in parsed) return parsed.response;

    const page = await listApplicationsPage({
      status: parsed.data.status,
      interviewing: parsed.data.interviewing === "1",
      q: parsed.data.q,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return NextResponse.json({ ok: true, ...page });
  });
}

export async function POST(req: Request) {
  return withDashboardApi(async () => {
    const body = markAppliedBodySchema.safeParse(await req.json());
    if (!body.success) return zodBadRequest(body.error);

    const result = await markApplied({
      postingId: body.data.posting_id,
      applicationUrl: body.data.application_url,
      resumeVersion: body.data.resume_version,
      notes: body.data.notes,
      appliedAt: body.data.applied_at,
    });
    return NextResponse.json({ ok: true, ...result });
  });
}
