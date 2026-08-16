import { NextResponse } from "next/server";

import { withDashboardApi, zodBadRequest } from "@/lib/dashboard/api";
import {
  updateApplicationBodySchema,
  uuidSchema,
} from "@/lib/dashboard/validation";
import { getApplicationDetail, updateApplicationWithEvent } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return withDashboardApi(async () => {
    const { id } = await ctx.params;
    const idParsed = uuidSchema.safeParse(id);
    if (!idParsed.success) return zodBadRequest(idParsed.error);

    const detail = await getApplicationDetail(idParsed.data);
    if (!detail) {
      return NextResponse.json({ ok: false, found: false }, { status: 404 });
    }
    return NextResponse.json({ ok: true, found: true, ...detail });
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  return withDashboardApi(async () => {
    const { id } = await ctx.params;
    const idParsed = uuidSchema.safeParse(id);
    if (!idParsed.success) return zodBadRequest(idParsed.error);

    const body = updateApplicationBodySchema.safeParse(await req.json());
    if (!body.success) return zodBadRequest(body.error);

    const result = await updateApplicationWithEvent({
      applicationId: idParsed.data,
      status: body.data.status,
      notes: body.data.notes,
    });
    return NextResponse.json({ ok: true, ...result });
  });
}
