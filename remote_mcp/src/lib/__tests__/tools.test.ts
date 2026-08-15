import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/db/client", () => {
  return {
    getSql: () => {
      throw new Error("getSql should not be called directly in unit tests");
    },
    resetSqlClient: () => undefined,
  };
});

vi.mock("@/lib/db/jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/jobs")>("@/lib/db/jobs");
  return {
    ...actual,
    saveJob: vi.fn(async (input: Record<string, unknown>) => {
      const id = "11111111-1111-4111-8111-111111111111";
      const now = new Date().toISOString();
      const job = {
        id,
        company: input.company,
        title: input.title,
        url: input.url,
        location: input.location ?? null,
        source: input.source ?? null,
        description: input.description ?? null,
        description_hash: input.description_hash ?? null,
        required_skills: input.required_skills ?? [],
        preferred_skills: input.preferred_skills ?? [],
        remote_status: input.remote_status ?? null,
        salary: input.salary ?? null,
        posted_date: input.posted_date ?? null,
        created_at: now,
        updated_at: now,
      };
      store.set(id, job);
      return job;
    }),
    getJob: vi.fn(async (id: string) => store.get(id) ?? null),
    searchJobs: vi.fn(async (query: string) => ({
      jobs: Array.from(store.values()).filter((job) =>
        JSON.stringify(job).toLowerCase().includes(query.toLowerCase()),
      ),
      nextOffset: null,
    })),
    listRecentJobs: vi.fn(async () => ({
      jobs: Array.from(store.values()),
      nextOffset: null,
    })),
    deleteJob: vi.fn(async (id: string) => store.delete(id)),
  };
});

import type { McpServer } from "@modelcontextprotocol/server";
import { registerJobTools } from "@/lib/mcp/tools";
import * as jobs from "@/lib/db/jobs";

describe("MCP job tools (persistence)", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  function makeExtra(scopes: string[]) {
    return {
      http: {
        authInfo: {
          token: "test-token",
          clientId: "test-client",
          scopes,
        },
      },
    };
  }

  it("save → get → search → list → delete → get-missing", async () => {
    type Handler = (
      args: Record<string, unknown>,
      extra: ReturnType<typeof makeExtra>,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const tools: Record<string, { config: Record<string, unknown>; handler: Handler }> = {};
    const server = {
      registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
        tools[name] = { config, handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);

    const writeExtra = makeExtra(["jobs:write", "jobs:read", "jobs:delete"]);

    const saveResult = await tools.save_job.handler(
      {
        company: "Acme",
        title: "Engineer",
        url: "https://example.com/jobs/1",
        location: "Remote",
        source: "test",
        description: "Build things",
        description_hash: "abc123",
        posted_date: "2026-08-15",
      },
      writeExtra,
    );
    const savePayload = JSON.parse(saveResult.content[0].text);
    expect(savePayload.ok).toBe(true);
    expect(savePayload.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const id = savePayload.id as string;

    const getResult = await tools.get_job.handler({ id }, writeExtra);
    const getPayload = JSON.parse(getResult.content[0].text);
    expect(getPayload.found).toBe(true);
    expect(getPayload.job.company).toBe("Acme");
    expect(getPayload.job.title).toBe("Engineer");
    expect(getPayload.job.description_hash).toBe("abc123");

    const searchResult = await tools.search_jobs.handler(
      { query: "Acme", limit: 10, offset: 0 },
      writeExtra,
    );
    const searchPayload = JSON.parse(searchResult.content[0].text);
    expect(searchPayload.count).toBe(1);

    const listResult = await tools.list_recent_jobs.handler(
      { days: 7, limit: 10, offset: 0 },
      writeExtra,
    );
    const listPayload = JSON.parse(listResult.content[0].text);
    expect(listPayload.count).toBe(1);

    const deleteResult = await tools.delete_job.handler({ id }, writeExtra);
    const deletePayload = JSON.parse(deleteResult.content[0].text);
    expect(deletePayload.deleted).toBe(true);

    const missing = await tools.get_job.handler({ id }, writeExtra);
    const missingPayload = JSON.parse(missing.content[0].text);
    expect(missingPayload.found).toBe(false);

    expect(jobs.saveJob).toHaveBeenCalled();
    expect(jobs.deleteJob).toHaveBeenCalledWith(id);
  });

  it("rejects an invalid posted_date before persistence", async () => {
    type Handler = (
      args: Record<string, unknown>,
      extra: ReturnType<typeof makeExtra>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    const tools: Record<string, { handler: Handler }> = {};
    const server = {
      registerTool(name: string, _config: Record<string, unknown>, handler: Handler) {
        tools[name] = { handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);

    const result = await tools.save_job.handler(
      {
        company: "Acme",
        title: "Engineer",
        url: "https://example.com/jobs/2",
        posted_date: "not-a-date",
      },
      makeExtra(["jobs:write"]),
    );

    expect(result.isError).toBe(true);
    expect(jobs.saveJob).not.toHaveBeenCalled();
  });
});
