import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as healthGET } from "@/app/api/health/route";
import { SCOPES } from "@/lib/config";
import { enforceToolPermission } from "@/lib/auth/http";
import { extractPermissions, hasPermission } from "@/lib/auth/permissions";
import {
  AuthValidationError,
  resetJwksCache,
  verifyAccessToken,
} from "@/lib/auth/jwt";

const ISSUER = "https://example-tenant.us.auth0.com/";
const AUDIENCE = "https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp";

describe("health endpoint", () => {
  it("works without authentication", async () => {
    process.env.DATABASE_URL = "postgresql://example";
    process.env.AUTH0_ISSUER = ISSUER;
    process.env.AUTH0_AUDIENCE = AUDIENCE;

    const response = await healthGET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("jay-job-mcp");
    expect(body.databaseConfigured).toBe(true);
    expect(body.authConfigured).toBe(true);
    expect(body.version).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });
});

describe("permissions helpers", () => {
  it("extracts Auth0 permissions and space-delimited scopes", () => {
    expect(
      extractPermissions({
        permissions: ["jobs:read", "jobs:write"],
        scope: "openid jobs:delete",
      }).sort(),
    ).toEqual(["jobs:delete", "jobs:read", "jobs:write", "openid"]);
  });

  it("checks tool permissions", () => {
    const auth = {
      token: "x",
      clientId: "c",
      scopes: [SCOPES.READ],
    };
    expect(hasPermission(auth, SCOPES.READ)).toBe(true);
    expect(hasPermission(auth, SCOPES.WRITE)).toBe(false);
  });
});

describe("JWT validation", () => {
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;

  beforeEach(async () => {
    resetJwksCache();
    process.env.AUTH0_ISSUER = ISSUER;
    process.env.AUTH0_AUDIENCE = AUDIENCE;

    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("jwks.json")) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetJwksCache();
  });

  async function signToken(claims: Record<string, unknown>, expSeconds = 60) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${expSeconds}s`)
      .sign(privateKey);
  }

  it("accepts a valid token and returns permissions", async () => {
    const token = await signToken({
      sub: "client@clients",
      azp: "python-agent",
      permissions: [SCOPES.READ, SCOPES.WRITE],
    });
    const auth = await verifyAccessToken(token);
    expect(auth.clientId).toBe("python-agent");
    expect(auth.scopes).toEqual(expect.arrayContaining([SCOPES.READ, SCOPES.WRITE]));
  });

  it("rejects missing token", async () => {
    await expect(verifyAccessToken(undefined)).rejects.toMatchObject({
      code: "missing_token",
    });
  });

  it("rejects malformed token", async () => {
    await expect(verifyAccessToken("not-a-jwt")).rejects.toBeInstanceOf(AuthValidationError);
  });

  it("rejects expired token", async () => {
    const token = await new SignJWT({ permissions: [SCOPES.READ] })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    await expect(verifyAccessToken(token)).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects wrong audience", async () => {
    const token = await new SignJWT({ permissions: [SCOPES.READ] })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience("https://wrong.example/api/mcp")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    await expect(verifyAccessToken(token)).rejects.toMatchObject({ code: "wrong_audience" });
  });

  it("rejects wrong issuer", async () => {
    const token = await new SignJWT({ permissions: [SCOPES.READ] })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://other-tenant.us.auth0.com/")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    await expect(verifyAccessToken(token)).rejects.toMatchObject({ code: "wrong_issuer" });
  });
});

describe("tool permission HTTP enforcement", () => {
  it("enforces modern Mcp-Method and Mcp-Name headers without parsing a body", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        "Mcp-Method": "tools/call",
        "Mcp-Name": "delete_job",
      },
    });
    const auth = { token: "t", clientId: "c", scopes: [SCOPES.READ] };

    const response = await enforceToolPermission(req, auth);
    expect(response?.status).toBe(403);
    expect(await response!.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("rejects a modern header/body tool-name mismatch", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_job",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_job", arguments: {} },
      }),
    });
    const auth = { token: "t", clientId: "c", scopes: [SCOPES.READ] };

    const response = await enforceToolPermission(req, auth);
    expect(response?.status).toBe(400);
  });

  it("requires Mcp-Name for a modern tools/call request", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: { "Mcp-Method": "tools/call" },
    });
    const auth = { token: "t", clientId: "c", scopes: [SCOPES.READ] };

    const response = await enforceToolPermission(req, auth);
    expect(response?.status).toBe(400);
  });

  it("returns 403 when token lacks required permission", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_job", arguments: {} },
      }),
    });
    req.auth = {
      token: "t",
      clientId: "c",
      scopes: [SCOPES.READ],
    };

    const response = await enforceToolPermission(req, req.auth);
    expect(response?.status).toBe(403);
    const body = await response!.json();
    expect(body.error).toBe("insufficient_scope");
  });

  it("allows jobs:write for save_job", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_job", arguments: {} },
      }),
    });
    const auth = {
      token: "t",
      clientId: "c",
      scopes: [SCOPES.WRITE],
    };
    expect(await enforceToolPermission(req, auth)).toBeNull();
  });

  it("allows jobs:read for get_job, search_jobs, list_recent_jobs", async () => {
    for (const name of ["get_job", "search_jobs", "list_recent_jobs"]) {
      const req = new Request("https://example.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
      const auth = { token: "t", clientId: "c", scopes: [SCOPES.READ] };
      expect(await enforceToolPermission(req, auth)).toBeNull();
    }
  });

  it("allows jobs:delete for delete_job", async () => {
    const req = new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_job", arguments: { id: "00000000-0000-4000-8000-000000000001" } },
      }),
    });
    const auth = { token: "t", clientId: "c", scopes: [SCOPES.DELETE] };
    expect(await enforceToolPermission(req, auth)).toBeNull();
  });
});
