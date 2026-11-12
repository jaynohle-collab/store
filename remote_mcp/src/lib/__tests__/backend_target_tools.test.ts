import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDatabaseUrl: vi.fn(), getSql: vi.fn() }));
vi.mock("@/lib/config", async (original) => ({ ...await original<typeof import("@/lib/config")>(), getDatabaseUrl: mocks.getDatabaseUrl }));
vi.mock("@/lib/db/client", () => ({ getSql: mocks.getSql }));
import { requiredPermissionForTool } from "@/lib/auth/permissions";
import { canonicalizeBackendTarget, backendTargetDigest, matchesBackendTarget } from "@/lib/db/backend_target";
import { registerBackendTargetTools } from "@/lib/mcp/backend_target_tools";

const URL = "postgresql://fixture:synthetic@ep-test-a1.us-east-2.aws.neon.tech/neondb?sslmode=require";
const challenge = "01".repeat(32);
const expected_digest = "8e15980c94b52368292b006313cb464e6afa695a493089c847988a8a627bddb7";
const input = { challenge, expected_digest };
type Result = { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> };
type Handler = (args: unknown, extra: unknown) => Promise<Result>;
const registered: Record<string, { config: Record<string, unknown>; handler: Handler }> = {};
registerBackendTargetTools({ registerTool: (name: string, config: Record<string, unknown>, handler: Handler) => { registered[name] = { config, handler }; } } as unknown as McpServer);
const handler = registered.compare_backend_database_target.handler;
const auth = (scopes = ["jobs:worker"]) => ({ http: { authInfo: { token: "fixture-token", clientId: "fixture-client" as unknown, scopes, extra: { sub: "fixture-worker" as unknown } } } });
const result = (matches: boolean, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify({ matches }) }], structuredContent: { matches } });
beforeEach(() => {
  mocks.getDatabaseUrl.mockReset().mockReturnValue(URL); mocks.getSql.mockReset();
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  for (const method of ["log", "warn", "error"] as const) expect(console[method]).not.toHaveBeenCalled();
  expect(mocks.getSql).not.toHaveBeenCalled(); vi.restoreAllMocks();
});

describe("configured target canonicalization", () => {
  it("matches the Python vector and nonce-binds it without credentials", () => {
    expect(canonicalizeBackendTarget(URL)).toBe('["neon-target-v1","ep-test-a1.us-east-2.aws.neon.tech","5432","neondb"]');
    expect(backendTargetDigest(URL, challenge).toString("hex")).toBe(expected_digest);
    expect(matchesBackendTarget(URL, challenge, expected_digest)).toBe(true);
    expect(matchesBackendTarget(URL, "02".repeat(32), expected_digest)).toBe(false);
  });
  it("normalizes only pooler alias, host case, port spelling, DB encoding", () => {
    for (const url of [URL.replace("ep-test-a1", "ep-test-a1-pooler"), URL.replace("ep-test-a1.us-east-2.aws.neon.tech", "EP-TEST-A1.US-EAST-2.AWS.NEON.TECH"), URL.replace("/neondb", ":05432/neondb"), URL.replace("neondb?", "%6Eeondb?"), URL.replace("postgresql:", "postgres:"), URL.replace("fixture:synthetic", "other:p%40ss%2Fword"), URL.replace("?sslmode=require", ""), URL + "&channel_binding=require"]) {
      expect(backendTargetDigest(url, challenge).toString("hex")).toBe(expected_digest);
    }
  });
  it("keeps endpoint, region, cloud, port and database distinctions", () => {
    for (const [old, replacement] of [["test-a1", "test-a2"], ["us-east-2", "us-east-1"], ["aws", "azure"], ["/neondb", ":5433/neondb"], ["neondb?", "Neondb?"], ["neondb?", "other?"]]) expect(matchesBackendTarget(URL.replace(old, replacement), challenge, expected_digest)).toBe(false);
  });
  it("rejects unsafe/ambiguous URL forms and target override queries", () => {
    const invalid = ["", "not-a-url", URL + "#fragment", URL + "#", URL + "\n", " " + URL,
      ...[["fixture", "f\\ixture"], ["fixture", "fíxture"], ["fixture:synthetic@", ""], ["fixture", ""], ["fixture", "fixture@another"], ["fixture", "%ZZ"], ["fixture", "%ff"], ["fixture", "%3Afoo"], ["fixture", "bad%00user"], ["fixture", "bad%0Auser"], ["postgresql", "POSTGRESQL"], ["ep-test-a1", "%65p-test-a1"], ["ep-test-a1", "ep-pooler"], ["ep-test-a1", "ep-" + "x".repeat(61)], ["neon.tech/", "neon.tech./"], ["neon.tech", "example.com"], ["aws.neon.tech", "gcp.neon.tech"], ["/neondb", ":0/neondb"], ["/neondb", ":65536/neondb"], ["/neondb", ":005432/neondb"], ["/neondb", ":/neondb"], ["/neondb", ":+5432/neondb"]].map(([a,b]) => URL.replace(a,b)),
      ...["", ".", "..", "%2e", "a/b", "a%2fb", "a%5Cb", "a%00b", "a%0A", "a%0D", "a%3Fb", "a%23b", "%ff", "%", "%252F", "é", "x".repeat(64)].map(db => URL.replace("/neondb", "/" + db)),
      ...["", "sslmode=disable", "sslmode=prefer", "channel_binding=disable", "options=endpoint", "host=other", "dbname=other", "database=other", "port=5433", "sslmode=require&sslmode=require", "%73slmode=require", "sslmode=%72equire", "sslmode=require&", "sslmode=require;host=other"].map(q => URL.replace("sslmode=require", q)),
      URL.replace("fixture", "x".repeat(8192))];
    for (const url of invalid) expect(() => canonicalizeBackendTarget(url), url).toThrow("backend_target_unavailable");
  });
  it("rejects invalid digest and nonce in pure helpers", () => {
    for (const bad of ["", "00".repeat(31), "00".repeat(33), "gg".repeat(32), "AB".repeat(32), challenge + "\n"]) {
      expect(() => backendTargetDigest(URL, bad)).toThrow(); expect(() => matchesBackendTarget(URL, challenge, bad)).toThrow();
    }
  });
});

describe("worker-only comparison tool", () => {
  it("registers read-only without reading configuration", () => {
    expect(Object.keys(registered)).toEqual(["compare_backend_database_target"]);
    expect(requiredPermissionForTool("compare_backend_database_target")).toBe("jobs:worker");
    expect(registered.compare_backend_database_target.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(mocks.getDatabaseUrl).not.toHaveBeenCalled();
  });
  it("denies missing auth and every nonworker scope before configuration access", async () => {
    for (const extra of [{}, { http: {} }, auth([]), auth(["jobs:read"]), auth(["jobs:write"]), auth(["jobs:revert"]), auth(["jobs:delete"]), auth(["jobs:read", "jobs:write", "jobs:revert"])]) expect(await handler(input, extra)).toEqual(result(false, true));
    expect(mocks.getDatabaseUrl).not.toHaveBeenCalled();
  });
  it("denies incomplete identities before configuration access", async () => {
    for (const value of [undefined, null, "", " ", "unknown", " unknown ", 17, {}]) {
      const a = auth(); a.http.authInfo.clientId = value; const b = auth(); b.http.authInfo.extra.sub = value;
      expect(await handler(input, a)).toEqual(result(false, true)); expect(await handler(input, b)).toEqual(result(false, true));
    }
    expect(mocks.getDatabaseUrl).not.toHaveBeenCalled();
  });
  it("rejects malformed and extra inputs before configuration access", async () => {
    for (const args of [undefined, null, [], {}, "", { challenge }, { ...input, sql: "select 1" }, { ...input, database_url: URL }, { ...input, challenge: "AB".repeat(32) }, { ...input, challenge: challenge + "\n" }, { ...input, expected_digest: "0" }, { ...input, expected_digest: 3 }]) expect(await handler(args, auth())).toEqual(result(false, true));
    expect(mocks.getDatabaseUrl).not.toHaveBeenCalled();
  });
  it("returns only boolean for matches and ordinary mismatches", async () => {
    expect(await handler(input, auth())).toEqual(result(true));
    expect(await handler({ ...input, expected_digest: "00".repeat(32) }, auth())).toEqual(result(false));
    expect(await handler({ ...input, challenge: "02".repeat(32) }, auth())).toEqual(result(false));
    expect(mocks.getDatabaseUrl).toHaveBeenCalledTimes(3);
  });
  it("redacts missing/bad configuration and secret-bearing errors without logs", async () => {
    for (const url of [undefined, "", URL + "&options=endpoint%3Dsecret"]) { mocks.getDatabaseUrl.mockReturnValueOnce(url); expect(await handler(input, auth())).toEqual(result(false, true)); }
    mocks.getDatabaseUrl.mockImplementationOnce(() => { throw new Error(URL); });
    expect(await handler(input, auth())).toEqual(result(false, true));
  });
});
