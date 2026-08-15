import { describe, expect, it, vi } from "vitest";

import { withMcpAuth } from "mcp-handler";
import { SCOPES } from "@/lib/config";

describe("MCP endpoint auth gate", () => {
  const inner = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  it("returns 401 without Authorization", async () => {
    const handler = withMcpAuth(inner, async () => undefined, {
      required: true,
      resourceMetadataPath: "/.well-known/oauth-protected-resource",
      resourceUrl: "https://example.com",
    });

    const response = await handler(new Request("https://example.com/api/mcp", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect(inner).not.toHaveBeenCalled();
  });

  it("returns 401 for malformed/invalid token (verify returns undefined)", async () => {
    const handler = withMcpAuth(inner, async () => undefined, {
      required: true,
      resourceUrl: "https://example.com",
    });

    const response = await handler(
      new Request("https://example.com/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer not-valid" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 when required scopes are missing at the auth wrapper", async () => {
    const handler = withMcpAuth(
      inner,
      async () => ({
        token: "t",
        clientId: "c",
        scopes: [SCOPES.READ],
      }),
      {
        required: true,
        requiredScopes: [SCOPES.WRITE],
        resourceUrl: "https://example.com",
      },
    );

    const response = await handler(
      new Request("https://example.com/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer valid" },
      }),
    );
    expect(response.status).toBe(403);
  });
});
