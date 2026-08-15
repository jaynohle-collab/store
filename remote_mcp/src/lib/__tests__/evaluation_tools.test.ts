import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluations: Record<string, unknown>[] = [];

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
    saveCanonicalJob: vi.fn(),
    getCanonicalJob: vi.fn(),
    touchCanonicalJob: vi.fn(),
    findCanonicalJobsByCompanyTitle: vi.fn(async () => []),
    findCanonicalJobsByCompany: vi.fn(async () => []),
    saveJobPosting: vi.fn(),
    updateJobPosting: vi.fn(),
    getJobPosting: vi.fn(),
    findJobPostingByNormalizedUrl: vi.fn(),
    findJobPostingBySourceExternalId: vi.fn(),
    listPostingsForCanonical: vi.fn(async () => []),
    searchJobPostings: vi.fn(async () => ({ postings: [], nextOffset: null })),
    listRecentPostings: vi.fn(async () => ({ postings: [], nextOffset: null })),
    listRepostedPostings: vi.fn(async () => []),
    listRepostsWithPriorApplications: vi.fn(async () => []),
    recordApplication: vi.fn(),
    getApplication: vi.fn(),
    listApplications: vi.fn(async () => []),
    updateApplicationStatus: vi.fn(),
    addApplicationEvent: vi.fn(),
    listApplicationEvents: vi.fn(async () => []),
    saveDiscoveryRun: vi.fn(),
    listDiscoveryRuns: vi.fn(async () => []),
  };
});

vi.mock("@/lib/db/evaluations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/evaluations")>(
    "@/lib/db/evaluations",
  );
  return {
    ...actual,
    saveJobEvaluation: vi.fn(async (input: Record<string, unknown>) => {
      const row = {
        id: `eval-${evaluations.length + 1}`,
        created_at: new Date().toISOString(),
        evaluated_at: input.evaluated_at || new Date().toISOString(),
        ...input,
      };
      evaluations.push(row);
      return row;
    }),
    getLatestJobEvaluation: vi.fn(async (postingId: string) => {
      const rows = evaluations
        .filter((e) => e.posting_id === postingId)
        .sort((a, b) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)));
      return rows[0] ?? null;
    }),
    listJobEvaluations: vi.fn(async (postingId: string) => {
      return evaluations
        .filter((e) => e.posting_id === postingId)
        .sort((a, b) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)));
    }),
  };
});

import type { McpServer } from "@modelcontextprotocol/server";
import { registerJobTools } from "@/lib/mcp/tools";

describe("MCP evaluation tools", () => {
  beforeEach(() => {
    evaluations.length = 0;
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
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      }
    > = {};
    const server = {
      registerTool(name: string, config: Record<string, unknown>, handler: (typeof tools)[string]["handler"]) {
        tools[name] = { config, handler };
      },
    } as unknown as McpServer;
    registerJobTools(server);
    return tools;
  }

  it("persists evaluations without claiming to score", async () => {
    const tools = register();
    expect(String(tools.save_job_evaluation.config.description)).toMatch(/does not score/i);

    const extra = makeExtra(["jobs:write", "jobs:read"]);
    const postingId = "11111111-1111-4111-8111-111111111111";
    await tools.save_job_evaluation.handler(
      {
        posting_id: postingId,
        match_score: 22,
        recommendation: "save",
        reason: "strong keyword overlap",
        scoring_version: "simple-v1",
        profile_version: "default-v1",
        evaluated_at: "2026-08-15T10:00:00.000Z",
      },
      extra,
    );
    await tools.save_job_evaluation.handler(
      {
        posting_id: postingId,
        match_score: 30,
        recommendation: "save",
        reason: "updated profile",
        scoring_version: "simple-v2",
        profile_version: "default-v2",
        evaluated_at: "2026-08-15T12:00:00.000Z",
      },
      extra,
    );

    const latest = JSON.parse(
      (
        await tools.get_latest_job_evaluation.handler({ posting_id: postingId }, extra)
      ).content[0].text,
    );
    expect(latest.evaluation.match_score).toBe(30);
    expect(latest.evaluation.scoring_version).toBe("simple-v2");

    const list = JSON.parse(
      (
        await tools.list_job_evaluations.handler({ posting_id: postingId, limit: 10 }, extra)
      ).content[0].text,
    );
    expect(list.count).toBe(2);
  });
});
