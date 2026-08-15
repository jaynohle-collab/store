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
    searchJobs: vi.fn(async (query: string) =>
      Array.from(store.values()).filter((job) =>
        JSON.stringify(job).toLowerCase().includes(query.toLowerCase()),
      ),
    ),
    listRecentJobs: vi.fn(async () => Array.from(store.values())),
    deleteJob: vi.fn(async (id: string) => store.delete(id)),
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobTools } from "@/lib/mcp/tools";
import * as jobs from "@/lib/db/jobs";

describe("MCP job tools (persistence)", () => {
  beforeEach(() => {
    store.clear();
  });

  function makeExtra(scopes: string[]) {
    return {
      authInfo: {
        token: "test-token",
        clientId: "test-client",
        scopes,
      },
      signal: new AbortController().signal,
      requestId: "1",
      sendNotification: async () => undefined,
      sendRequest: async () => {
        throw new Error("unused");
      },
    };
  }

  it("save → get → search → list → delete → get-missing", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobTools(server);

    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: Record<string, unknown>,
              extra: ReturnType<typeof makeExtra>,
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const writeExtra = makeExtra(["jobs:write", "jobs:read", "jobs:delete"]);

    const saveResult = await tools.save_job.handler(
      {
        company: "Acme",
        title: "Engineer",
        url: "https://example.com/jobs/1",
        location: "Remote",
        source: "test",
        description: "Build things",
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

    const searchResult = await tools.search_jobs.handler({ query: "Acme", limit: 10 }, writeExtra);
    const searchPayload = JSON.parse(searchResult.content[0].text);
    expect(searchPayload.count).toBe(1);

    const listResult = await tools.list_recent_jobs.handler({ days: 7, limit: 10 }, writeExtra);
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
});
