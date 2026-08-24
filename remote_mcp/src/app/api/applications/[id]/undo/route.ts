import { NextResponse } from "next/server";

import { withDashboardApi } from "@/lib/dashboard/api";
import { uuidSchema } from "@/lib/dashboard/validation";
import { undoApplied } from "@/lib/db/dashboard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  return withDashboardApi(async () => {
    const { id } = await ctx.params;
    const idParsed = uuidSchema.safeParse(id);
    if (!idParsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid application id" }, { status: 400 });
    }
    const result = await undoApplied(idParsed.data);
    return NextResponse.json({ ok: true, ...result });
  });
}
