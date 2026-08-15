import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  addApplicationEvent,
  addApplicationEventSchema,
  touchCanonicalJob,
  findCanonicalJobsByCompanyTitle,
  findCanonicalJobsByCompany,
  findJobPostingByNormalizedUrl,
  findJobPostingBySourceExternalId,
  getApplication,
  getCanonicalJob,
  getJobPosting,
  listApplicationEvents,
  listApplications,
  listDiscoveryRuns,
  listPostingsForCanonical,
  listRecentPostings,
  listRepostedPostings,
  listRepostsWithPriorApplications,
  recordApplication,
  recordApplicationSchema,
  saveCanonicalJob,
  saveCanonicalJobSchema,
  saveDiscoveryRun,
  saveDiscoveryRunSchema,
  saveJobPosting,
  saveJobPostingSchema,
  searchJobPostings,
  updateApplicationStatus,
  updateApplicationStatusSchema,
  updateJobPosting,
  updateJobPostingSchema,
} from "../db/lifecycle";

const PERSISTENCE_NOTE =
  " Persistence layer only — does not score, rank, classify SAME_POSTING/REPOST/NEW_JOB, or decide recommendations.";

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

export function registerLifecycleTools(server: McpServer): void {
  server.registerTool(
    "save_canonical_job",
    {
      title: "Save Canonical Job",
      description: "Insert a canonical job/role row." + PERSISTENCE_NOTE,
      inputSchema: saveCanonicalJobSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "save_canonical_job");
        const parsed = saveCanonicalJobSchema.parse(args);
        const job = await saveCanonicalJob(parsed);
        return jsonResult({ ok: true, id: job.id, canonical_job: job });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to save canonical job");
      }
    },
  );

  server.registerTool(
    "get_canonical_job",
    {
      title: "Get Canonical Job",
      description: "Retrieve a canonical job by UUID." + PERSISTENCE_NOTE,
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_canonical_job");
        const job = await getCanonicalJob(id);
        return jsonResult({ ok: true, found: Boolean(job), canonical_job: job });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to get canonical job");
      }
    },
  );

  server.registerTool(
    "find_canonical_jobs",
    {
      title: "Find Canonical Jobs",
      description: "Find canonical jobs by company_key and normalized_title." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        company_key: z.string().min(1),
        normalized_title: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ company_key, normalized_title, limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "find_canonical_jobs");
        const jobs = await findCanonicalJobsByCompanyTitle(company_key, normalized_title, limit ?? 20);
        return jsonResult({ ok: true, count: jobs.length, canonical_jobs: jobs });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to find canonical jobs");
      }
    },
  );

  server.registerTool(
    "find_canonical_jobs_by_company",
    {
      title: "Find Canonical Jobs By Company",
      description:
        "List canonical jobs for a company_key (paginated). Persistence only — does not score similarity." +
        PERSISTENCE_NOTE,
      inputSchema: z.object({
        company_key: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ company_key, limit, offset }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "find_canonical_jobs_by_company");
        const jobs = await findCanonicalJobsByCompany(
          company_key,
          limit ?? 100,
          offset ?? 0,
        );
        return jsonResult({
          ok: true,
          count: jobs.length,
          canonical_jobs: jobs,
          next_offset: jobs.length === (limit ?? 100) ? (offset ?? 0) + jobs.length : null,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to find canonical jobs by company",
        );
      }
    },
  );

  server.registerTool(
    "touch_canonical_job",
    {
      title: "Touch Canonical Job",
      description: "Update last_seen_at on a canonical job." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        id: z.string().uuid(),
        last_seen_at: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, last_seen_at }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "touch_canonical_job");
        const job = await touchCanonicalJob(id, last_seen_at);
        return jsonResult({ ok: true, found: Boolean(job), canonical_job: job });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to touch canonical job");
      }
    },
  );

  server.registerTool(
    "save_job_posting",
    {
      title: "Save Job Posting",
      description: "Insert a job posting occurrence." + PERSISTENCE_NOTE,
      inputSchema: saveJobPostingSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "save_job_posting");
        const parsed = saveJobPostingSchema.parse(args);
        const posting = await saveJobPosting(parsed);
        return jsonResult({ ok: true, id: posting.id, posting });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to save job posting");
      }
    },
  );

  server.registerTool(
    "update_job_posting",
    {
      title: "Update Job Posting",
      description: "Update mutable posting fields (e.g. last_seen_at)." + PERSISTENCE_NOTE,
      inputSchema: updateJobPostingSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "update_job_posting");
        const parsed = updateJobPostingSchema.parse(args);
        const posting = await updateJobPosting(parsed);
        return jsonResult({ ok: true, found: Boolean(posting), posting });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to update job posting");
      }
    },
  );

  server.registerTool(
    "get_job_posting",
    {
      title: "Get Job Posting",
      description: "Retrieve a job posting by UUID." + PERSISTENCE_NOTE,
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_job_posting");
        const posting = await getJobPosting(id);
        return jsonResult({ ok: true, found: Boolean(posting), posting });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to get job posting");
      }
    },
  );

  server.registerTool(
    "find_posting_by_url",
    {
      title: "Find Posting By URL",
      description: "Lookup a posting by normalized_url." + PERSISTENCE_NOTE,
      inputSchema: z.object({ normalized_url: z.string().min(1) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ normalized_url }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "find_posting_by_url");
        const posting = await findJobPostingByNormalizedUrl(normalized_url);
        return jsonResult({ ok: true, found: Boolean(posting), posting });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to find posting by URL");
      }
    },
  );

  server.registerTool(
    "find_posting_by_external_id",
    {
      title: "Find Posting By External ID",
      description: "Lookup a posting by source + external_job_id." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        source: z.string().min(1),
        external_job_id: z.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, external_job_id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "find_posting_by_external_id");
        const posting = await findJobPostingBySourceExternalId(source, external_job_id);
        return jsonResult({ ok: true, found: Boolean(posting), posting });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to find posting by external id",
        );
      }
    },
  );

  server.registerTool(
    "search_job_postings",
    {
      title: "Search Job Postings",
      description: "Search postings by company, title, url, or external id." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
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
        assertToolPermission(getAuth(extra), "search_job_postings");
        const page = await searchJobPostings(query, limit ?? 20, offset ?? 0);
        return jsonResult({
          ok: true,
          count: page.postings.length,
          postings: page.postings,
          next_offset: page.nextOffset,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to search postings");
      }
    },
  );

  server.registerTool(
    "list_recent_postings",
    {
      title: "List Recent Postings",
      description: "List postings first seen within the last N days." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        days: z.number().int().min(1).max(36500).default(7),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
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
        assertToolPermission(getAuth(extra), "list_recent_postings");
        const page = await listRecentPostings(days ?? 7, limit ?? 20, offset ?? 0);
        return jsonResult({
          ok: true,
          count: page.postings.length,
          postings: page.postings,
          next_offset: page.nextOffset,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list recent postings");
      }
    },
  );

  server.registerTool(
    "list_postings_for_canonical",
    {
      title: "List Postings For Canonical Job",
      description: "List all postings for a canonical job." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        canonical_job_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ canonical_job_id, limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_postings_for_canonical");
        const postings = await listPostingsForCanonical(canonical_job_id, limit ?? 50);
        return jsonResult({ ok: true, count: postings.length, postings });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list postings");
      }
    },
  );

  server.registerTool(
    "list_reposted_postings",
    {
      title: "List Reposted Postings",
      description: "List postings flagged is_repost=true." + PERSISTENCE_NOTE,
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_reposted_postings");
        const postings = await listRepostedPostings(limit ?? 50);
        return jsonResult({ ok: true, count: postings.length, postings });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list reposts");
      }
    },
  );

  server.registerTool(
    "list_reposts_with_prior_applications",
    {
      title: "List Reposts With Prior Applications",
      description:
        "List reposted postings whose canonical job has a prior application on a different posting." +
        PERSISTENCE_NOTE,
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_reposts_with_prior_applications");
        const postings = await listRepostsWithPriorApplications(limit ?? 50);
        return jsonResult({ ok: true, count: postings.length, postings });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list reposts with prior applications",
        );
      }
    },
  );

  server.registerTool(
    "record_application",
    {
      title: "Record Application",
      description: "Create an application attached to a specific posting." + PERSISTENCE_NOTE,
      inputSchema: recordApplicationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "record_application");
        const parsed = recordApplicationSchema.parse(args);
        const application = await recordApplication(parsed);
        return jsonResult({ ok: true, id: application.id, application });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to record application");
      }
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Get Application",
      description: "Retrieve an application by UUID." + PERSISTENCE_NOTE,
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_application");
        const application = await getApplication(id);
        return jsonResult({ ok: true, found: Boolean(application), application });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to get application");
      }
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List Applications",
      description: "List applications with optional filters." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        status: z.string().optional(),
        canonical_job_id: z.string().uuid().optional(),
        posting_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_applications");
        const applications = await listApplications({
          status: args.status,
          canonicalJobId: args.canonical_job_id,
          postingId: args.posting_id,
          limit: args.limit ?? 50,
        });
        return jsonResult({ ok: true, count: applications.length, applications });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list applications");
      }
    },
  );

  server.registerTool(
    "update_application_status",
    {
      title: "Update Application Status",
      description: "Update application status / notes." + PERSISTENCE_NOTE,
      inputSchema: updateApplicationStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "update_application_status");
        const parsed = updateApplicationStatusSchema.parse(args);
        const application = await updateApplicationStatus(parsed);
        return jsonResult({ ok: true, found: Boolean(application), application });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to update application status",
        );
      }
    },
  );

  server.registerTool(
    "add_application_event",
    {
      title: "Add Application Event",
      description: "Append an immutable-ish application timeline event." + PERSISTENCE_NOTE,
      inputSchema: addApplicationEventSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "add_application_event");
        const parsed = addApplicationEventSchema.parse(args);
        const event = await addApplicationEvent(parsed);
        return jsonResult({ ok: true, id: event.id, event });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to add application event");
      }
    },
  );

  server.registerTool(
    "list_application_events",
    {
      title: "List Application Events",
      description: "List timeline events for an application." + PERSISTENCE_NOTE,
      inputSchema: z.object({ application_id: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ application_id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_application_events");
        const events = await listApplicationEvents(application_id);
        return jsonResult({ ok: true, count: events.length, events });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list application events",
        );
      }
    },
  );

  server.registerTool(
    "save_discovery_run",
    {
      title: "Save Discovery Run",
      description: "Record counts for a discovery execution." + PERSISTENCE_NOTE,
      inputSchema: saveDiscoveryRunSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "save_discovery_run");
        const parsed = saveDiscoveryRunSchema.parse(args);
        const run = await saveDiscoveryRun(parsed);
        return jsonResult({ ok: true, id: run.id, discovery_run: run });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to save discovery run");
      }
    },
  );

  server.registerTool(
    "list_discovery_runs",
    {
      title: "List Discovery Runs",
      description: "List recent discovery run summaries." + PERSISTENCE_NOTE,
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_discovery_runs");
        const runs = await listDiscoveryRuns(limit ?? 20);
        return jsonResult({ ok: true, count: runs.length, discovery_runs: runs });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list discovery runs");
      }
    },
  );
}
