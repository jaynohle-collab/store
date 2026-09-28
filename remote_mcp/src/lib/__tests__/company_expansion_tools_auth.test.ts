import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    throw new Error("getSql should not be called in unit tests");
  },
  getTransactionalSql: () => {
    throw new Error("getTransactionalSql should not be called in unit tests");
  },
  resetSqlClient: () => undefined,
}));

vi.mock("@/lib/db/discovery_company_candidates", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/discovery_company_candidates")
  >("@/lib/db/discovery_company_candidates");
  return {
    ...actual,
    upsertDiscoveryCompanyCandidates: vi.fn(async () => ({ results: [], inserted_count: 0 })),
    claimDiscoveryCompanyCandidates: vi.fn(async () => ({ claimed_count: 0, candidates: [] })),
    recordDiscoveryCompanyVerification: vi.fn(async () => ({ ok: true })),
    listDiscoveryCompanyCandidates: vi.fn(async () => []),
    listDiscoveryPostingUrlHints: vi.fn(async () => []),
  };
});

import type { McpServer } from "@modelcontextprotocol/server";
import * as candidates from "@/lib/db/discovery_company_candidates";
import { registerCompanyExpansionTools } from "@/lib/mcp/company_expansion_tools";

type Handler = (
  args: Record<string, unknown>,
  extra: { http: { authInfo: { token: string; clientId: string; scopes: string[] } } },
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function register(): Record<string, { config: Record<string, unknown>; handler: Handler }> {
  const tools: Record<string, { config: Record<string, unknown>; handler: Handler }> = {};
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
      tools[name] = { config, handler };
    },
  } as unknown as McpServer;
  registerCompanyExpansionTools(server);
  return tools;
}

const extra = (scopes: string[]) => ({
  http: { authInfo: { token: "t", clientId: "c", scopes } },
});

const WORKER_TOOLS = [
  "upsert_discovery_company_candidates",
  "claim_discovery_company_candidates",
  "record_discovery_company_verification",
];

describe("company expansion tool authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects worker tools for ChatGPT read/write tokens without touching storage", async () => {
    const tools = register();
    for (const name of WORKER_TOOLS) {
      const result = await tools[name].handler({}, extra(["jobs:read", "jobs:write"]));
      expect(result.isError, name).toBe(true);
    }
    expect(candidates.upsertDiscoveryCompanyCandidates).not.toHaveBeenCalled();
    expect(candidates.claimDiscoveryCompanyCandidates).not.toHaveBeenCalled();
    expect(candidates.recordDiscoveryCompanyVerification).not.toHaveBeenCalled();
  });

  it("allows read tools with jobs:read and worker tools with jobs:worker", async () => {
    const tools = register();
    const list = await tools.list_discovery_company_candidates.handler({}, extra(["jobs:read"]));
    expect(list.isError).toBeFalsy();
    const hints = await tools.list_discovery_posting_url_hints.handler({}, extra(["jobs:read"]));
    expect(hints.isError).toBeFalsy();
    const claim = await tools.claim_discovery_company_candidates.handler(
      { worker_identity: "w", limit: 1, lease_minutes: 15 },
      extra(["jobs:read", "jobs:write", "jobs:worker"]),
    );
    expect(claim.isError).toBeFalsy();
    expect(candidates.claimDiscoveryCompanyCandidates).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated calls", async () => {
    const tools = register();
    const result = await tools.list_discovery_company_candidates.handler(
      {},
      { http: undefined } as unknown as ReturnType<typeof extra>,
    );
    expect(result.isError).toBe(true);
  });

  it("describes MCP as state-only (no crawling, scoring, or verification)", () => {
    const tools = register();
    for (const { config } of Object.values(tools)) {
      expect(String(config.description)).toMatch(/never crawls/i);
    }
  });
});
