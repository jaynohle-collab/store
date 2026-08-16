import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.fn();
const auth0Middleware = vi.fn(async () => {
  const { NextResponse } = await import("next/server");
  return NextResponse.next();
});

vi.mock("@/lib/auth0", () => ({
  auth0: {
    middleware: (...args: unknown[]) => auth0Middleware(...args),
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

import { middleware } from "@/middleware";
import {
  isDashboardProtectedPath,
  isEmailAllowed,
  isMcpOrPublicAuthPath,
  requireDashboardApiUser,
  DashboardAuthError,
} from "@/lib/dashboard/auth";

describe("dashboard path helpers", () => {
  it("protects dashboard pages and APIs", () => {
    expect(isDashboardProtectedPath("/dashboard")).toBe(true);
    expect(isDashboardProtectedPath("/dashboard/jobs")).toBe(true);
    expect(isDashboardProtectedPath("/api/dashboard/summary")).toBe(true);
    expect(isDashboardProtectedPath("/api/jobs")).toBe(true);
    expect(isDashboardProtectedPath("/api/applications")).toBe(true);
    expect(isDashboardProtectedPath("/api/discovery-runs")).toBe(true);
  });

  it("does not treat MCP/health/well-known/auth as dashboard-protected", () => {
    expect(isMcpOrPublicAuthPath("/api/mcp")).toBe(true);
    expect(isMcpOrPublicAuthPath("/api/health")).toBe(true);
    expect(isMcpOrPublicAuthPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isMcpOrPublicAuthPath("/auth/login")).toBe(true);
    expect(isDashboardProtectedPath("/api/mcp")).toBe(false);
    expect(isDashboardProtectedPath("/api/health")).toBe(false);
  });
});

describe("DASHBOARD_ALLOWED_EMAILS gate", () => {
  afterEach(() => {
    delete process.env.DASHBOARD_ALLOWED_EMAILS;
  });

  it("requires allowlist membership", () => {
    process.env.DASHBOARD_ALLOWED_EMAILS = "owner@example.com, other@example.com";
    expect(isEmailAllowed("owner@example.com")).toBe(true);
    expect(isEmailAllowed("OWNER@example.com")).toBe(true);
    expect(isEmailAllowed("stranger@example.com")).toBe(false);
    expect(isEmailAllowed(undefined)).toBe(false);
  });

  it("denies everyone when allowlist is empty", () => {
    process.env.DASHBOARD_ALLOWED_EMAILS = "";
    expect(isEmailAllowed("owner@example.com")).toBe(false);
  });
});

describe("requireDashboardApiUser", () => {
  beforeEach(() => {
    process.env.DASHBOARD_ALLOWED_EMAILS = "owner@example.com";
    getSession.mockReset();
  });

  afterEach(() => {
    delete process.env.DASHBOARD_ALLOWED_EMAILS;
  });

  it("throws 401 when unauthenticated", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireDashboardApiUser()).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<DashboardAuthError>);
  });

  it("throws 403 when email is not verified", async () => {
    getSession.mockResolvedValue({
      user: { email: "owner@example.com", email_verified: false },
    });
    await expect(requireDashboardApiUser()).rejects.toMatchObject({ status: 403 });
  });

  it("throws 403 when email is not allowlisted", async () => {
    getSession.mockResolvedValue({
      user: { email: "stranger@example.com", email_verified: true },
    });
    await expect(requireDashboardApiUser()).rejects.toMatchObject({ status: 403 });
  });

  it("returns the user when authenticated and authorized", async () => {
    getSession.mockResolvedValue({
      user: { email: "owner@example.com", email_verified: true, sub: "auth0|1" },
    });
    await expect(requireDashboardApiUser()).resolves.toMatchObject({
      email: "owner@example.com",
      emailVerified: true,
    });
  });
});

describe("middleware dashboard auth", () => {
  beforeEach(() => {
    process.env.DASHBOARD_ALLOWED_EMAILS = "owner@example.com";
    getSession.mockReset();
    auth0Middleware.mockClear();
  });

  afterEach(() => {
    delete process.env.DASHBOARD_ALLOWED_EMAILS;
  });

  function req(path: string) {
    return new NextRequest(new URL(path, "http://localhost:3000"));
  }

  it("returns 401 JSON for unauthenticated dashboard API", async () => {
    getSession.mockResolvedValue(null);
    const res = await middleware(req("/api/jobs"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("returns 403 JSON for authenticated but unauthorized dashboard API", async () => {
    getSession.mockResolvedValue({
      user: { email: "stranger@example.com", email_verified: true },
    });
    const res = await middleware(req("/api/applications"));
    expect(res.status).toBe(403);
  });

  it("redirects unauthenticated dashboard page to login", async () => {
    getSession.mockResolvedValue(null);
    const res = await middleware(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/login");
  });

  it("does not block MCP endpoint with dashboard session auth", async () => {
    getSession.mockResolvedValue(null);
    const res = await middleware(req("/api/mcp"));
    expect(res.status).toBe(200);
    expect(auth0Middleware).toHaveBeenCalled();
    // Must not return 401 from dashboard gate
    const text = await res.text();
    expect(text).not.toContain("Authentication required");
  });

  it("does not block health or well-known", async () => {
    getSession.mockResolvedValue(null);
    expect((await middleware(req("/api/health"))).status).toBe(200);
    expect(
      (await middleware(req("/.well-known/oauth-protected-resource"))).status,
    ).toBe(200);
  });
});
