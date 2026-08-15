import { beforeEach, describe, expect, it, vi } from "vitest";

const canonicalStore = new Map<string, Record<string, unknown>>();
const postingStore = new Map<string, Record<string, unknown>>();
const applicationStore = new Map<string, Record<string, unknown>>();
const eventStore = new Map<string, Record<string, unknown>>();
const discoveryStore = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/db/client", () => ({
  getSql: () => {
    throw new Error("getSql should not be called directly in unit tests");
  },
  resetSqlClient: () => undefined,
}));

vi.mock("@/lib/db/jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/jobs")>("@/lib/db/jobs");
  return {
    ...actual,
    saveJob: vi.fn(),
    getJob: vi.fn(),
    searchJobs: vi.fn(),
    listRecentJobs: vi.fn(),
    deleteJob: vi.fn(),
  };
});

vi.mock("@/lib/db/lifecycle", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/lifecycle")>("@/lib/db/lifecycle");
  return {
    ...actual,
    saveCanonicalJob: vi.fn(async (input: Record<string, unknown>) => {
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const row = { id, ...input, created_at: new Date().toISOString() };
      canonicalStore.set(id, row);
      return row;
    }),
    getCanonicalJob: vi.fn(async (id: string) => canonicalStore.get(id) ?? null),
    touchCanonicalJob: vi.fn(async (id: string) => {
      const row = canonicalStore.get(id);
      if (!row) return null;
      row.last_seen_at = new Date().toISOString();
      return row;
    }),
    findCanonicalJobsByCompanyTitle: vi.fn(async () => Array.from(canonicalStore.values())),
    saveJobPosting: vi.fn(async (input: Record<string, unknown>) => {
      const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const row = { id, is_repost: false, ...input };
      postingStore.set(id, row);
      return row;
    }),
    updateJobPosting: vi.fn(async (input: Record<string, unknown>) => {
      const row = postingStore.get(String(input.id));
      if (!row) return null;
      Object.assign(row, input);
      return row;
    }),
    getJobPosting: vi.fn(async (id: string) => postingStore.get(id) ?? null),
    findJobPostingByNormalizedUrl: vi.fn(async () => null),
    findJobPostingBySourceExternalId: vi.fn(async () => null),
    listPostingsForCanonical: vi.fn(async () => Array.from(postingStore.values())),
    searchJobPostings: vi.fn(async () => ({ postings: Array.from(postingStore.values()), nextOffset: null })),
    listRecentPostings: vi.fn(async () => ({ postings: Array.from(postingStore.values()), nextOffset: null })),
    listRepostedPostings: vi.fn(async () => Array.from(postingStore.values()).filter((p) => p.is_repost)),
    listRepostsWithPriorApplications: vi.fn(async () => []),
    recordApplication: vi.fn(async (input: Record<string, unknown>) => {
      const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const row = { id, ...input };
      applicationStore.set(id, row);
      return row;
    }),
    getApplication: vi.fn(async (id: string) => applicationStore.get(id) ?? null),
    listApplications: vi.fn(async () => Array.from(applicationStore.values())),
    updateApplicationStatus: vi.fn(async (input: Record<string, unknown>) => {
      const row = applicationStore.get(String(input.id));
      if (!row) return null;
      Object.assign(row, input);
      return row;
    }),
    addApplicationEvent: vi.fn(async (input: Record<string, unknown>) => {
      const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const row = { id, ...input };
      eventStore.set(id, row);
      return row;
    }),
    listApplicationEvents: vi.fn(async () => Array.from(eventStore.values())),
    saveDiscoveryRun: vi.fn(async (input: Record<string, unknown>) => {
      const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const row = { id, ...input };
      discoveryStore.set(id, row);
      return row;
    }),
    listDiscoveryRuns: vi.fn(async () => Array.from(discoveryStore.values())),
  };
});

import type { McpServer } from "@modelcontextprotocol/server";
import { registerJobTools } from "@/lib/mcp/tools";
import { TOOL_PERMISSIONS } from "@/lib/config";

describe("MCP lifecycle tools (persistence only)", () => {
  beforeEach(() => {
    canonicalStore.clear();
    postingStore.clear();
    applicationStore.clear();
    eventStore.clear();
    discoveryStore.clear();
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

  function register(): Record<
    string,
    {
      config: Record<string, unknown>;
      handler: (
        args: Record<string, unknown>,
        extra: ReturnType<typeof makeExtra>,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  > {
    const tools: Record<
      string,
      {
        config: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: ReturnType<typeof makeExtra>,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
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

  it("registers lifecycle tools without scoring/repost language that implies decisions", () => {
    const tools = register();
    expect(tools.save_canonical_job).toBeTruthy();
    expect(tools.save_job_posting).toBeTruthy();
    expect(tools.record_application).toBeTruthy();
    expect(tools.save_discovery_run).toBeTruthy();
    expect(TOOL_PERMISSIONS.save_job_posting).toBe("jobs:write");
    expect(TOOL_PERMISSIONS.list_applications).toBe("jobs:read");

    const description = String(tools.save_job_posting.config.description || "");
    expect(description.toLowerCase()).toContain("persistence");
    expect(description).toMatch(/does not score, rank, classify/i);
  });

  it("persists canonical → posting → application → event → discovery run", async () => {
    const tools = register();
    const extra = makeExtra(["jobs:write", "jobs:read"]);

    const canonical = JSON.parse(
      (
        await tools.save_canonical_job.handler(
          {
            company: "Anthropic",
            company_key: "anthropic",
            title: "Staff AI Engineer",
            normalized_title: "staff ai engineer",
          },
          extra,
        )
      ).content[0].text,
    );
    expect(canonical.ok).toBe(true);

    const posting = JSON.parse(
      (
        await tools.save_job_posting.handler(
          {
            canonical_job_id: canonical.id,
            source: "greenhouse",
            external_job_id: "111",
            url: "https://example.com/jobs/111",
            normalized_url: "https://example.com/jobs/111",
          },
          extra,
        )
      ).content[0].text,
    );
    expect(posting.ok).toBe(true);

    const application = JSON.parse(
      (
        await tools.record_application.handler(
          {
            canonical_job_id: canonical.id,
            posting_id: posting.id,
            status: "applied",
          },
          extra,
        )
      ).content[0].text,
    );
    expect(application.ok).toBe(true);

    const event = JSON.parse(
      (
        await tools.add_application_event.handler(
          {
            application_id: application.id,
            event_type: "applied",
          },
          extra,
        )
      ).content[0].text,
    );
    expect(event.ok).toBe(true);

    const run = JSON.parse(
      (
        await tools.save_discovery_run.handler(
          {
            source: "test",
            jobs_discovered: 3,
            new_jobs: 1,
            reposts: 1,
            duplicates: 1,
          },
          extra,
        )
      ).content[0].text,
    );
    expect(run.ok).toBe(true);
    expect(run.discovery_run.duplicates).toBe(1);
  });
});
