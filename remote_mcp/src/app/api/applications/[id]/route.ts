import { NextResponse } from "next/server";

import { APPLICATION_STATUS_TRANSITIONS } from "@/lib/dashboard/constants";
import { getApplicationDetail, updateApplicationWithEvent } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const detail = await getApplicationDetail(id);
    if (!detail) {
      return NextResponse.json({ ok: false, found: false }, { status: 404 });
    }
    return NextResponse.json({ ok: true, found: true, ...detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get application";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { status?: string; notes?: string };
    if (!body.status) {
      return NextResponse.json({ ok: false, error: "status required" }, { status: 400 });
    }
    if (!(APPLICATION_STATUS_TRANSITIONS as readonly string[]).includes(body.status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }
    const result = await updateApplicationWithEvent({
      applicationId: id,
      status: body.status,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update application";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
