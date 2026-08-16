import { NextResponse } from "next/server";

import { auth0 } from "@/lib/auth0";

export type DashboardUser = {
  email: string;
  emailVerified: boolean;
  sub?: string;
  name?: string;
};

export class DashboardAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DashboardAuthError";
    this.status = status;
  }
}

export function getAllowedDashboardEmails(): string[] {
  const raw = process.env.DASHBOARD_ALLOWED_EMAILS ?? "";
  return raw
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailAllowed(email: string | undefined | null): boolean {
  if (!email) return false;
  const allowed = getAllowedDashboardEmails();
  if (!allowed.length) return false;
  return allowed.includes(email.trim().toLowerCase());
}

export async function getDashboardSessionUser(): Promise<DashboardUser | null> {
  const session = await auth0.getSession();
  if (!session?.user) return null;
  const email = typeof session.user.email === "string" ? session.user.email : undefined;
  if (!email) return null;
  const emailVerified =
    typeof session.user.email_verified === "boolean"
      ? session.user.email_verified
      : false;
  return {
    email,
    emailVerified,
    sub: typeof session.user.sub === "string" ? session.user.sub : undefined,
    name: typeof session.user.name === "string" ? session.user.name : undefined,
  };
}

/** Throws DashboardAuthError(401|403) — for API route handlers. */
export async function requireDashboardApiUser(): Promise<DashboardUser> {
  const user = await getDashboardSessionUser();
  if (!user) {
    throw new DashboardAuthError(401, "Authentication required");
  }
  if (!user.emailVerified) {
    throw new DashboardAuthError(403, "Email not verified");
  }
  if (!isEmailAllowed(user.email)) {
    throw new DashboardAuthError(403, "Dashboard access denied for this account");
  }
  return user;
}

export function dashboardAuthErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof DashboardAuthError) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: error.status },
    );
  }
  return null;
}

export function isDashboardProtectedPath(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/api/dashboard") ||
    pathname.startsWith("/api/jobs") ||
    pathname.startsWith("/api/applications") ||
    pathname.startsWith("/api/discovery-runs")
  );
}

export function isMcpOrPublicAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/.well-known") ||
    pathname.startsWith("/auth")
  );
}
