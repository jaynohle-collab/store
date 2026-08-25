import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  applyDiscoveryBatchJobPersistence,
  applyDiscoveryBatchJobPersistenceSchema,
} from "../db/discovery_batch_worker_apply";
import {
  enrichBatchStatusVisibility,
  previewDiscoveryBatchRevert,
  previewDiscoveryBatchRevertSchema,
  revertDiscoveryBatch,
  revertDiscoveryBatchSchema,
} from "../db/discovery_batch_revert";
import {
  getDiscoveryBatch,
  recoverStaleDiscoveryBatchClaims,
} from "../db/inbox";

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

const WORKER_NOTE =
  " Worker-only tool requiring jobs:worker. Not for ChatGPT connectors. " +
  "Does not score or classify jobs; persists Python decisions atomically with provenance.";

const REVERT_NOTE =
  " Persistence compensation only. Requires prior preview_discovery_batch_revert " +
  "and the exact preview_hash. Never deletes applications, evaluations, or audit history.";

/**
 * Public ChatGPT-facing revert tools (jobs:read / jobs:revert).
 */
export function registerDiscoveryBatchRevertTools(server: McpServer): void {
  server.registerTool(
    "preview_discovery_batch_revert",
    {
      title: "Preview Discovery Batch Revert",
      description:
        "Read-only compensating plan for a processed discovery batch. " +
        "Makes no database changes. ChatGPT must show this plan and obtain explicit " +
        "user confirmation before calling revert_discovery_batch." +
        REVERT_NOTE,
      inputSchema: previewDiscoveryBatchRevertSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "preview_discovery_batch_revert");
        const parsed = previewDiscoveryBatchRevertSchema.parse(args);
        const preview = await previewDiscoveryBatchRevert(parsed.batch_id);
        return jsonResult({ ok: true, preview });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to preview discovery batch revert",
        );
      }
    },
  );

  server.registerTool(
    "revert_discovery_batch",
    {
      title: "Revert Discovery Batch",
      description:
        "Atomically compensate a previously previewed discovery batch. " +
        "Requires jobs:revert (not jobs:delete) and the exact preview_hash. " +
        "Clients must confirm after preview; vague delete requests must not bypass preview." +
        REVERT_NOTE,
      inputSchema: revertDiscoveryBatchSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "revert_discovery_batch");
        const parsed = revertDiscoveryBatchSchema.parse(args);
        const result = await revertDiscoveryBatch(parsed);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to revert discovery batch",
        );
      }
    },
  );
}

/**
 * Worker-only tools (jobs:worker). ChatGPT M2M/user apps must not receive this scope.
 */
export function registerDiscoveryBatchWorkerTools(server: McpServer): void {
  server.registerTool(
    "apply_discovery_batch_job_persistence",
    {
      title: "Apply Discovery Batch Job Persistence",
      description:
        "Atomically persist one inbox job mutation + provenance under the owning attempt." +
        WORKER_NOTE,
      inputSchema: applyDiscoveryBatchJobPersistenceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(
          getAuth(extra),
          "apply_discovery_batch_job_persistence",
        );
        const parsed = applyDiscoveryBatchJobPersistenceSchema.parse(args);
        const result = await applyDiscoveryBatchJobPersistence(parsed);
        return jsonResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to apply discovery batch job persistence",
        );
      }
    },
  );

  server.registerTool(
    "recover_stale_discovery_batch_claims",
    {
      title: "Recover Stale Discovery Batch Claims",
      description:
        "Fail-closed stale-claim recovery. Requeues only when mutation_started=false " +
        "on the durable attempt; otherwise marks failed for operator review." +
        WORKER_NOTE,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, extra) => {
      try {
        assertToolPermission(
          getAuth(extra),
          "recover_stale_discovery_batch_claims",
        );
        const result = await recoverStaleDiscoveryBatchClaims(limit ?? 20);
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to recover stale discovery batch claims",
        );
      }
    },
  );
}

/** Backward-compatible enrichment helper used by get_discovery_batch. */
export async function getDiscoveryBatchWithVisibility(id: string) {
  const batch = await getDiscoveryBatch(id);
  return enrichBatchStatusVisibility(batch);
}
