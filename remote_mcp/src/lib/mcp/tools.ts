import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  deleteJob,
  getJob,
  listRecentJobs,
  saveJob,
  saveJobInputSchema,
  postedDateSchema,
  searchJobs,
} from "../db/jobs";
import { registerLifecycleTools } from "./lifecycle_tools";

const PERSISTENCE_NOTE =
  " Persistence layer only — does not score, rank, detect duplicates, or decide whether a job should be saved.";

function getAuth(context: { http?: { authInfo?: AuthInfo } }): AuthInfo | undefined {
  return context.http?.authInfo;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerJobTools(server: McpServer): void {
  registerLifecycleTools(server);

  server.registerTool(
    "save_job",
    {
      title: "Save Job",
      description: "Store a job posting in Neon PostgreSQL." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        company: z.string().min(1).describe("Company name"),
        title: z.string().min(1).describe("Job title"),
        url: z.string().url().describe("Canonical job posting URL"),
        location: z.string().optional().describe("Job location"),
        source: z.string().optional().describe("Discovery source"),
        description: z.string().optional().describe("Job description text"),
        description_hash: z.string().min(1).max(128).optional().describe("Python-computed description fingerprint"),
        required_skills: z.array(z.string()).optional().describe("Required skills"),
        preferred_skills: z.array(z.string()).optional().describe("Preferred skills"),
        remote_status: z.string().optional().describe("Remote / hybrid / onsite status"),
        salary: z.string().optional().describe("Salary text"),
        posted_date: postedDateSchema.optional().describe("Posted date (ISO date or datetime with offset)"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "save_job");
        const parsed = saveJobInputSchema.parse(args);
        const job = await saveJob(parsed);
        return jsonResult({ ok: true, id: job.id, job });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save job";
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Job",
      description: "Retrieve a stored job by UUID." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        id: z.string().uuid().describe("Job UUID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_job");
        const job = await getJob(id);
        if (!job) {
          return jsonResult({ ok: false, found: false, id });
        }
        return jsonResult({ ok: true, found: true, job });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to get job";
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search Jobs",
      description:
        "Search stored jobs across company, title, url, location, source, and description." +
        PERSISTENCE_NOTE,
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Zero-based pagination offset"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, offset }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "search_jobs");
        const page = await searchJobs(query, limit ?? 20, offset ?? 0);
        return jsonResult({
          ok: true,
          count: page.jobs.length,
          jobs: page.jobs,
          next_offset: page.nextOffset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to search jobs";
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "list_recent_jobs",
    {
      title: "List Recent Jobs",
      description: "List jobs created within the last N days." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        days: z.number().int().min(1).max(36500).default(7).describe("Lookback window in days"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Zero-based pagination offset"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ days, limit, offset }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_recent_jobs");
        const page = await listRecentJobs(days ?? 7, limit ?? 20, offset ?? 0);
        return jsonResult({
          ok: true,
          count: page.jobs.length,
          jobs: page.jobs,
          next_offset: page.nextOffset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to list jobs";
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "delete_job",
    {
      title: "Delete Job",
      description: "Permanently delete a stored job by UUID. Destructive." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        id: z.string().uuid().describe("Job UUID"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "delete_job");
        const deleted = await deleteJob(id);
        return jsonResult({ ok: true, deleted, id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete job";
        return errorResult(message);
      }
    },
  );
}
