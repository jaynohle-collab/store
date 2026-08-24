import { NextResponse } from "next/server";
import { z } from "zod";

import { withDashboardApi, parseSearchParams, zodBadRequest } from "@/lib/dashboard/api";
import { markAppliedBodySchema, paginationSchema } from "@/lib/dashboard/validation";
import { listApplicationsPage, markApplied } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

const applicationsQuerySchema = paginationSchema.extend({
  status: z.string().max(64).optional(),
  interviewing: z.enum(["0", "1"]).optional(),
  applied_only: z.enum(["0", "1"]).optional(),
  q: z.string().max(512).optional(),
  sort: z.enum(["applied", "company", "title", "status"]).default("applied"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [25, 50, 100].includes(n)).default(25),
});

export async function GET(req: Request) {
  return withDashboardApi(async () => {
    const url = new URL(req.url);
    const parsed = parseSearchParams(applicationsQuerySchema, url);
    if ("response" in parsed) return parsed.response;

    const page = await listApplicationsPage({
      status: parsed.data.status,
      interviewing: parsed.data.interviewing === "1",
      appliedOnly: parsed.data.applied_only !== "0",
      q: parsed.data.q,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
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
