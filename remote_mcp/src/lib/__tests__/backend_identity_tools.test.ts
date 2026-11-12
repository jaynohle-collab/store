import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSql: vi.fn(), sql: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.getSql() }));

import { requiredPermissionForTool } from "@/lib/auth/permissions";
import { registerBackendIdentityTools } from "@/lib/mcp/backend_identity_tools";

type Result = {
  isError: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
};
type Handler = (args: unknown, extra: unknown) => Promise<Result>;
const registered: Record<string, { config: Record<string, unknown>; handler: Handler }> = {};
registerBackendIdentityTools({
  registerTool: (name: string, config: Record<string, unknown>, handler: Handler) => {
    registered[name] = { config, handler };
  },
} as unknown as McpServer);
const handler = registered.get_backend_database_role.handler;
const auth = (scopes = ["jobs:worker"], clientId: unknown = "fixture-client", sub: unknown = "fixture-worker") => ({
  http: { authInfo: { token: "fixture-token", clientId, scopes, extra: { sub } } },
});
const failure = {
  isError: true,
  content: [{ type: "text", text: '{"ok":false,"error":"backend_identity_unavailable"}' }],
  structuredContent: { ok: false, error: "backend_identity_unavailable" },
};

beforeEach(() => {
  mocks.sql.mockReset().mockResolvedValue([{ database_role: "fixture_backend" }]);
  mocks.getSql.mockReset().mockReturnValue(mocks.sql);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(console.log).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("read-only backend identity diagnostic", () => {
  it("registers only the worker-scoped read-only tool", () => {
    expect(Object.keys(registered)).toEqual(["get_backend_database_role"]);
    expect(requiredPermissionForTool("get_backend_database_role")).toBe("jobs:worker");
    expect(registered.get_backend_database_role.config.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and every non-worker scope before DB construction", async () => {
    for (const extra of [{}, { http: {} }, auth([]), auth(["jobs:read"]), auth(["jobs:write"]),
      auth(["jobs:revert"]), auth(["jobs:delete"]), auth(["jobs:read", "jobs:write", "jobs:revert"])]) {
      expect(await handler({}, extra)).toEqual(failure);
    }
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("requires authenticated client and subject identities", async () => {
    for (const value of [undefined, null, "", " ", "unknown", " unknown ", 17, {}]) {
      const missingClient = auth();
      missingClient.http.authInfo.clientId = value;
      const missingSubject = auth();
      missingSubject.http.authInfo.extra.sub = value;
      expect(await handler({}, missingClient)).toEqual(failure);
      expect(await handler({}, missingSubject)).toEqual(failure);
    }
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects SQL, configuration and other caller inputs before DB access", async () => {
    for (const input of [undefined, null, [], "", { sql: "SELECT current_user" },
      { profile_id: "fixture" }, { database_role: "other" }, { DATABASE_URL: "fixture" }]) {
      expect(await handler(input, auth())).toEqual(failure);
    }
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("executes exactly one static metadata SELECT with no parameters", async () => {
    const result = await handler({}, auth());
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: '{"ok":true,"database_role":"fixture_backend"}' }],
      structuredContent: { ok: true, database_role: "fixture_backend" },
    });
    expect(mocks.getSql).toHaveBeenCalledOnce();
    expect(mocks.sql).toHaveBeenCalledOnce();
    expect(mocks.sql.mock.calls[0]).toHaveLength(1);
    expect(Array.from(mocks.sql.mock.calls[0][0])).toEqual(["SELECT current_user::text AS database_role"]);
  });

  it("projects only the role, never incidental fields or auth/configuration values", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fixture:synthetic-secret@example.invalid/private");
    mocks.sql.mockResolvedValue([{ database_role: 'Fixture "Backend"', password: "synthetic-secret", host: "private-host" }]);
    const result = await handler({}, auth());
    expect(result.structuredContent).toEqual({ ok: true, database_role: 'Fixture "Backend"' });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|private-host|fixture-token|fixture-client/);
  });

  it("rejects missing, malformed, oversized and control-character results without fallback", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://environment_role:synthetic-secret@example.invalid/private");
    for (const rows of [[], [{ database_role: "one" }, { database_role: "two" }], [{}],
      ...[null, 42, {}, "", " ", "x".repeat(64), "é".repeat(32), "unsafe\nrole", "unsafe\0role"]
        .map(database_role => [{ database_role }])]) {
      mocks.sql.mockResolvedValueOnce(rows);
      expect(await handler({}, auth())).toEqual(failure);
    }
  });

  it("redacts database construction and query errors without logging or retry", async () => {
    const secretError = new Error("postgres://fixture:synthetic-secret@example.invalid/private");
    mocks.getSql.mockImplementationOnce(() => { throw secretError; });
    expect(await handler({}, auth())).toEqual(failure);
    expect(mocks.sql).not.toHaveBeenCalled();
    mocks.sql.mockRejectedValueOnce(secretError);
    expect(await handler({}, auth())).toEqual(failure);
    expect(mocks.sql).toHaveBeenCalledOnce();
  });
});
