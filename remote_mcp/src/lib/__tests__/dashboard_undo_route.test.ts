import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.fn();
const undoAppliedMock = vi.fn();

vi.mock("@/lib/auth0", () => ({
  auth0: {
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

vi.mock("@/lib/db/dashboard", () => ({
  undoApplied: (...args: unknown[]) => undoAppliedMock(...args),
  UndoAppliedError: class UndoAppliedError extends Error {},
}));

import { POST } from "@/app/api/applications/[id]/undo/route";

describe("POST /api/applications/[id]/undo", () => {
  beforeEach(() => {
    process.env.DASHBOARD_ALLOWED_EMAILS = "owner@example.com";
    getSession.mockReset();
    undoAppliedMock.mockReset();
  });

  afterEach(() => {
    delete process.env.DASHBOARD_ALLOWED_EMAILS;
  });

  function req(id: string) {
    return new NextRequest(
      new URL(`http://localhost/api/applications/${id}/undo`, "http://localhost"),
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
  }

  it("returns 401 when unauthenticated", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(req("11111111-1111-4111-8111-111111111111"), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(res.status).toBe(401);
    expect(undoAppliedMock).not.toHaveBeenCalled();
  });

  it("returns 403 for authenticated but unauthorized email", async () => {
    getSession.mockResolvedValue({
      user: { email: "stranger@example.com", email_verified: true },
    });
    const res = await POST(req("11111111-1111-4111-8111-111111111111"), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(res.status).toBe(403);
    expect(undoAppliedMock).not.toHaveBeenCalled();
  });

  it("returns 200 for authorized request", async () => {
    getSession.mockResolvedValue({
      user: { email: "owner@example.com", email_verified: true },
    });
    undoAppliedMock.mockResolvedValue({
      application: { id: "11111111-1111-4111-8111-111111111111", status: "planned" },
      event: { event_type: "undo_applied" },
    });
    const res = await POST(req("11111111-1111-4111-8111-111111111111"), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(undoAppliedMock).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("returns 400 for malformed application id", async () => {
    getSession.mockResolvedValue({
      user: { email: "owner@example.com", email_verified: true },
    });
    const res = await POST(req("not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    expect(undoAppliedMock).not.toHaveBeenCalled();
  });
});
