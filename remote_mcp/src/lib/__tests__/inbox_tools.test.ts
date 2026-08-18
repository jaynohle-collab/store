import { beforeEach, describe, expect, it, vi } from "vitest";

type Batch = Record<string, unknown>;

const batches: Batch[] = [];

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    throw new Error("getSql should not be called directly in unit tests");
  },
  resetSqlClient: () => undefined,
}));

vi.mock("@/lib/db/inbox", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/inbox")>("@/lib/db/inbox");

  function clone(row: Batch): Batch {
    return JSON.parse(JSON.stringify(row)) as Batch;
  }

  return {
    ...actual,
    submitDiscoveryBatch: vi.fn(async (input: { jobs: unknown[]; source: string; metadata?: Record<string, unknown> }) => {
      const row: Batch = {
        id: `inbox-${batches.length + 1}`,
        source: input.source,
        status: "pending",
        payload: { jobs: input.jobs },
        job_count: input.jobs.length,
        submitted_at: new Date().toISOString(),
        processing_started_at: null,
        processed_at: null,
        error: null,
        metadata: input.metadata ?? {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      batches.push(row);
      return clone(row);
    }),
    getDiscoveryBatch: vi.fn(async (id: string) => {
      const row = batches.find((b) => b.id === id);
      return row ? clone(row) : null;
    }),
    listPendingDiscoveryBatches: vi.fn(async (limit = 20) => {
      return batches.filter((b) => b.status === "pending").slice(0, limit).map(clone);
    }),
    claimDiscoveryBatch: vi.fn(async (id?: string) => {
      const row = id
        ? batches.find((b) => b.id === id)
        : batches.find((b) => b.status === "pending");
      if (!row || row.status !== "pending") return null;
      row.status = "processing";
      row.processing_started_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      return clone(row);
    }),
    completeDiscoveryBatch: vi.fn(async (id: string) => {
      const row = batches.find((b) => b.id === id);
      if (!row || row.status !== "processing") return null;
      row.status = "completed";
      row.processed_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      return clone(row);
    }),
    failDiscoveryBatch: vi.fn(async (id: string, error: string) => {
      const row = batches.find((b) => b.id === id);
      if (!row || row.status !== "processing") return null;
      row.status = "failed";
      row.error = error;
      row.processed_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      return clone(row);
    }),
  };
});

import type { McpServer } from "@modelcontextprotocol/server";
import { TOOL_PERMISSIONS } from "@/lib/config";
import { registerJobTools } from "@/lib/mcp/tools";

const VALID_JOB = {
  company: "AgentForge",
  title: "Staff AI Engineer, Agent Platform",
  url: "https://example.com/jobs/staff-ai",
  location: "United States",
  source: "Greenhouse",
  description: "Build production LLM agents.",
  required_skills: ["Python"],
  preferred_skills: [] as string[],
  remote_status: "Remote",
  salary: "$220k",
  posted_date: "2026-08-16",
};

describe("MCP discovery inbox tools", () => {
  beforeEach(() => {
    batches.length = 0;
    vi.clearAllMocks();
  });

  function makeExtra(scopes: string[]) {
    return {
      http: {
        authInfo: { token: "t", clientId: "c", scopes },
      },
    };
  }

  function register() {
    const tools: Record<
      string,
      {
        config: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: ReturnType<typeof makeExtra>,
        ) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>;
      }
    > = {};
    const server = {
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (typeof tools)[string]["handler"],
      ) {
        tools[name] = { config, handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);
    return tools;
  }

  function parse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
    if (result.isError) return { isError: true, text: result.content[0]?.text };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  it("does not claim to score or classify in tool descriptions", () => {
    const tools = register();
    expect(String(tools.submit_discovery_batch.config.description)).toMatch(/does not score/i);
    expect(String(tools.submit_discovery_batch.config.description)).toMatch(/duplicates/i);
  });

  it("maps inbox tools to read/write scopes", () => {
    expect(TOOL_PERMISSIONS.submit_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.claim_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.complete_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.fail_discovery_batch).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.get_discovery_batch).toBe("jobs:read");
    expect(TOOL_PERMISSIONS.list_pending_discovery_batches).toBe("jobs:read");
  });

  it("submits a valid discovery batch as pending", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [VALID_JOB], source: "chatgpt", metadata: {} },
        extra,
      ),
    );
    expect(result.ok).toBe(true);
    expect((result.batch as Batch).status).toBe("pending");
    expect((result.batch as Batch).job_count).toBe(1);
  });

  it("rejects invalid raw schema", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ company: "X" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("rejects discovery-provided match_score", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, match_score: 99 }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("rejects empty company", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, company: "" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("rejects whitespace-only company", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, company: "   " }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it("rejects empty title", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, title: "" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
  });

  it("rejects empty url", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, url: "" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
  });

  it("rejects empty description", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, description: "" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(result.isError).toBe(true);
  });

  it("accepts optional empty fields on an otherwise valid job", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const result = parse(
      await tools.submit_discovery_batch.handler(
        {
          jobs: [
            {
              ...VALID_JOB,
              location: "",
              source: "",
              remote_status: "",
              salary: "",
              posted_date: "",
            },
          ],
          source: "chatgpt",
        },
        extra,
      ),
    );
    expect(result.ok).toBe(true);
    expect((result.batch as Batch).status).toBe("pending");
  });

  it("rejects invalid remote_status and posted_date", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write"]);
    const remote = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, remote_status: "WFH" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(remote.isError).toBe(true);
    const posted = parse(
      await tools.submit_discovery_batch.handler(
        { jobs: [{ ...VALID_JOB, posted_date: "08/16/2026" }], source: "chatgpt" },
        extra,
      ),
    );
    expect(posted.isError).toBe(true);
  });

  it("lists pending batches", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);
    await tools.submit_discovery_batch.handler({ jobs: [VALID_JOB], source: "chatgpt" }, extra);
    const listed = parse(
      await tools.list_pending_discovery_batches.handler({ limit: 20 }, extra),
    );
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
  });

  it("atomically claims pending -> processing and cannot reclaim", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);
    const submitted = parse(
      await tools.submit_discovery_batch.handler({ jobs: [VALID_JOB], source: "chatgpt" }, extra),
    );
    const id = (submitted.batch as Batch).id as string;
    const first = parse(await tools.claim_discovery_batch.handler({ id }, extra));
    expect(first.claimed).toBe(true);
    expect((first.batch as Batch).status).toBe("processing");
    const second = parse(await tools.claim_discovery_batch.handler({ id }, extra));
    expect(second.claimed).toBe(false);
  });

  it("cannot claim a completed batch", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);
    const submitted = parse(
      await tools.submit_discovery_batch.handler({ jobs: [VALID_JOB], source: "chatgpt" }, extra),
    );
    const id = (submitted.batch as Batch).id as string;
    await tools.claim_discovery_batch.handler({ id }, extra);
    const completed = parse(await tools.complete_discovery_batch.handler({ id }, extra));
    expect(completed.completed).toBe(true);
    const claimed = parse(await tools.claim_discovery_batch.handler({ id }, extra));
    expect(claimed.claimed).toBe(false);
  });

  it("fail retains the raw payload", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);
    const submitted = parse(
      await tools.submit_discovery_batch.handler({ jobs: [VALID_JOB], source: "chatgpt" }, extra),
    );
    const id = (submitted.batch as Batch).id as string;
    await tools.claim_discovery_batch.handler({ id }, extra);
    const failed = parse(
      await tools.fail_discovery_batch.handler({ id, error: "python failed" }, extra),
    );
    expect((failed.batch as Batch).status).toBe("failed");
    expect((failed.batch as Batch).error).toBe("python failed");
    const fetched = parse(await tools.get_discovery_batch.handler({ id }, extra));
    expect(((fetched.batch as Batch).payload as { jobs: unknown[] }).jobs).toHaveLength(1);
  });
});
