import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  claimDueDiscoveryCompanies,
  claimDueDiscoveryCompaniesSchema,
  completeDiscoveryCompanyRun,
  completeDiscoveryCompanyRunSchema,
  failDiscoveryCompanyRun,
  failDiscoveryCompanyRunSchema,
  finishAutomaticDiscoveryRun,
  finishAutomaticDiscoveryRunSchema,
  getAutomaticDiscoveryStatus,
  getStorageObservability,
  listDiscoveryCompanies,
  previewDescriptionRetention,
  startAutomaticDiscoveryRun,
  startAutomaticDiscoveryRunSchema,
  upsertDiscoveryCompany,
  upsertDiscoveryCompanySchema,
} from "../db/discovery_companies";
import {
  claimPendingDiscoveryEvaluations,
  claimPendingDiscoveryEvaluationsSchema,
  completePendingDiscoveryEvaluation,
  completePendingDiscoveryEvaluationSchema,
  preservePendingDiscoveryEvaluations,
  preservePendingDiscoveryEvaluationsSchema,
} from "../db/discovery_pending_evaluations";
import { previewDescriptionRetentionSchema } from "../discovery/storage_retention";

const NOTE =
  " Company registry / automatic discovery control plane only — does not crawl ATS boards," +
  " call LLMs, score jobs, or persist canonical postings. Python owns adapters + gpt-fit-v2 evaluation.";

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

export function registerAutomaticDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "list_discovery_companies",
    {
      title: "List Discovery Companies",
      description: "List companies in the automatic discovery registry." + NOTE,
      inputSchema: z
        .object({
          limit: z.number().int().min(1).max(500).optional().default(100),
          offset: z.number().int().min(0).max(100_000).optional().default(0),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_discovery_companies");
        const companies = await listDiscoveryCompanies(args.limit, args.offset);
        return jsonResult({ ok: true, companies, count: companies.length });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list discovery companies",
        );
      }
    },
  );

  server.registerTool(
    "upsert_discovery_company",
    {
      title: "Upsert Discovery Company",
      description:
        "Create or update a discovery company registry entry. Never store secrets here." + NOTE,
      inputSchema: upsertDiscoveryCompanySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "upsert_discovery_company");
        const company = await upsertDiscoveryCompany(args);
        return jsonResult({ ok: true, company });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to upsert discovery company",
        );
      }
    },
  );

  server.registerTool(
    "claim_due_discovery_companies",
    {
      title: "Claim Due Discovery Companies",
      description:
        "Claim up to N due companies with lease ownership for automatic scanning." + NOTE,
      inputSchema: claimDueDiscoveryCompaniesSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "claim_due_discovery_companies");
        const result = await claimDueDiscoveryCompanies(args);
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to claim discovery companies",
        );
      }
    },
  );

  server.registerTool(
    "complete_discovery_company_run",
    {
      title: "Complete Discovery Company Run",
      description: "Mark a claimed company scan successful and schedule the next scan." + NOTE,
      inputSchema: completeDiscoveryCompanyRunSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "complete_discovery_company_run");
        const result = await completeDiscoveryCompanyRun(args);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to complete company run",
        );
      }
    },
  );

  server.registerTool(
    "fail_discovery_company_run",
    {
      title: "Fail Discovery Company Run",
      description: "Mark a claimed company scan failed and apply exponential backoff." + NOTE,
      inputSchema: failDiscoveryCompanyRunSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "fail_discovery_company_run");
        const result = await failDiscoveryCompanyRun(args);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to fail company run",
        );
      }
    },
  );

  server.registerTool(
    "start_automatic_discovery_run",
    {
      title: "Start Automatic Discovery Run",
      description: "Record the start of a producer workflow run." + NOTE,
      inputSchema: startAutomaticDiscoveryRunSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "start_automatic_discovery_run");
        const run = await startAutomaticDiscoveryRun(args);
        return jsonResult({ ok: true, run });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to start automatic discovery run",
        );
      }
    },
  );

  server.registerTool(
    "finish_automatic_discovery_run",
    {
      title: "Finish Automatic Discovery Run",
      description: "Record completion metrics for a producer workflow run." + NOTE,
      inputSchema: finishAutomaticDiscoveryRunSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "finish_automatic_discovery_run");
        const run = await finishAutomaticDiscoveryRun(args);
        return jsonResult({ ok: true, run });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to finish automatic discovery run",
        );
      }
    },
  );

  server.registerTool(
    "get_automatic_discovery_status",
    {
      title: "Get Automatic Discovery Status",
      description:
        "Dashboard summary: latest producer runs, due companies, pending/failed batches." + NOTE,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_automatic_discovery_status");
        const status = await getAutomaticDiscoveryStatus();
        return jsonResult({ ok: true, ...status });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to get automatic discovery status",
        );
      }
    },
  );

  server.registerTool(
    "get_storage_observability",
    {
      title: "Get Storage Observability",
      description:
        "Report database and major table sizes for Neon free-tier capacity planning." + NOTE,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_storage_observability");
        const storage = await getStorageObservability();
        return jsonResult({ ok: true, ...storage });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to get storage observability",
        );
      }
    },
  );

  server.registerTool(
    "preview_description_retention",
    {
      title: "Preview Description Retention",
      description:
        "Dry-run only: list inactive postings whose full descriptions could be cleared after N days." +
        " Never deletes. Production cleanup stays disabled." +
        NOTE,
      inputSchema: previewDescriptionRetentionSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "preview_description_retention");
        const preview = await previewDescriptionRetention(args);
        return jsonResult({ ok: true, ...preview });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to preview description retention",
        );
      }
    },
  );

  server.registerTool(
    "preserve_pending_discovery_evaluations",
    {
      title: "Preserve Pending Discovery Evaluations",
      description:
        "Durably store candidates that could not be LLM-evaluated (quota / all providers down)." +
        " Idempotent by fingerprint. Does not submit inbox jobs." +
        NOTE,
      inputSchema: preservePendingDiscoveryEvaluationsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "preserve_pending_discovery_evaluations");
        const result = await preservePendingDiscoveryEvaluations(args);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to preserve pending discovery evaluations",
        );
      }
    },
  );

  server.registerTool(
    "claim_pending_discovery_evaluations",
    {
      title: "Claim Pending Discovery Evaluations",
      description:
        "Claim preserved pending candidates for evaluation resume." + NOTE,
      inputSchema: claimPendingDiscoveryEvaluationsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "claim_pending_discovery_evaluations");
        const result = await claimPendingDiscoveryEvaluations(args);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to claim pending discovery evaluations",
        );
      }
    },
  );

  server.registerTool(
    "complete_pending_discovery_evaluation",
    {
      title: "Complete Pending Discovery Evaluation",
      description:
        "Mark a preserved pending candidate completed or abandoned after evaluation." +
        NOTE,
      inputSchema: completePendingDiscoveryEvaluationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "complete_pending_discovery_evaluation");
        const result = await completePendingDiscoveryEvaluation(args);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to complete pending discovery evaluation",
        );
      }
    },
  );
}
