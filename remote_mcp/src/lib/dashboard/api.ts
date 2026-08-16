import { NextResponse } from "next/server";
import type { ZodError, ZodType } from "zod";

import {
  dashboardAuthErrorResponse,
  requireDashboardApiUser,
} from "@/lib/dashboard/auth";
import { ConflictError } from "@/lib/db/dashboard";

export function zodBadRequest(error: ZodError): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "Invalid request",
      details: error.flatten(),
    },
    { status: 400 },
  );
}

export function parseSearchParams<T>(
  schema: ZodType<T>,
  url: URL,
): { data: T } | { response: NextResponse } {
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { response: zodBadRequest(parsed.error) };
  }
  return { data: parsed.data };
}

export async function withDashboardApi(
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    await requireDashboardApiUser();
    return await handler();
  } catch (error) {
    const auth = dashboardAuthErrorResponse(error);
    if (auth) return auth;
    if (error instanceof ConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Request failed";
    const notFound = /not found/i.test(message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: notFound ? 404 : 500 },
    );
  }
}
