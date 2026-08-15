import { NextResponse } from "next/server";

import { getDashboardJob, ignorePosting } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const job = await getDashboardJob(id);
    if (!job) {
      return NextResponse.json({ ok: false, found: false, id }, { status: 404 });
    }
    return NextResponse.json({ ok: true, found: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get job";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { action?: string };
    if (body.action === "ignore") {
      const posting = await ignorePosting(id);
      if (!posting) {
        return NextResponse.json({ ok: false, found: false }, { status: 404 });
      }
      return NextResponse.json({ ok: true, posting });
    }
    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update job";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
