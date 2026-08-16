import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { auth0 } from "@/lib/auth0";
import {
  isDashboardProtectedPath,
  isEmailAllowed,
  isMcpOrPublicAuthPath,
} from "@/lib/dashboard/auth";

/**
 * Auth0 v4 middleware:
 * - Always mounts /auth/* session routes via auth0.middleware
 * - Does NOT gate MCP bearer auth (/api/mcp), health, or OAuth metadata
 * - Protects dashboard pages (redirect login) and dashboard APIs (401/403 JSON)
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let Auth0 SDK handle /auth/* first; never apply dashboard gates to MCP/public.
  const authResponse = await auth0.middleware(request);

  if (isMcpOrPublicAuthPath(pathname) || pathname.startsWith("/auth")) {
    return authResponse;
  }

  if (!isDashboardProtectedPath(pathname)) {
    return authResponse;
  }

  // Allow the unauthorized page itself once a session exists (avoid redirect loops).
  if (pathname === "/dashboard/unauthorized") {
    const session = await auth0.getSession(request);
    if (!session?.user) {
      const login = new URL("/auth/login", request.nextUrl.origin);
      login.searchParams.set("returnTo", pathname);
      return NextResponse.redirect(login);
    }
    return authResponse;
  }

  const session = await auth0.getSession(request);
  const isApi = pathname.startsWith("/api/");

  if (!session?.user) {
    if (isApi) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 },
      );
    }
    const login = new URL("/auth/login", request.nextUrl.origin);
    login.searchParams.set("returnTo", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }

  const email = typeof session.user.email === "string" ? session.user.email : undefined;
  const emailVerified =
    typeof session.user.email_verified === "boolean" ? session.user.email_verified : false;

  if (!email || !emailVerified || !isEmailAllowed(email)) {
    if (isApi) {
      return NextResponse.json(
        {
          ok: false,
          error: !emailVerified
            ? "Email not verified"
            : "Dashboard access denied for this account",
        },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/dashboard/unauthorized", request.nextUrl.origin));
  }

  // Preserve Auth0 cookie/session refresh headers from middleware.
  return authResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
