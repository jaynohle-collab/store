import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  claimDiscoveryBatch,
  completeDiscoveryBatch,
  failDiscoveryBatch,
  getDiscoveryBatch,
  listPendingDiscoveryBatches,
  submitDiscoveryBatch,
  submitDiscoveryBatchSchema,
} from "../db/inbox";

const PERSISTENCE_NOTE =
  " Persistence layer only — stores raw ChatGPT discovery JSON. Does not score jobs, detect duplicates, classify reposts, or create canonical jobs.";

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

export function registerInboxTools(server: McpServer): void {
  server.registerTool(
    "submit_discovery_batch",
    {
      title: "Submit Discovery Batch",
      description:
        "Store a raw ChatGPT job discovery batch in the inbox for later Python processing." +
        PERSISTENCE_NOTE,
      inputSchema: submitDiscoveryBatchSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "submit_discovery_batch");
        const parsed = submitDiscoveryBatchSchema.parse(args);
        const batch = await submitDiscoveryBatch(parsed);
        return jsonResult({ ok: true, id: batch.id, batch });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to submit discovery batch",
        );
      }
    },
  );

  server.registerTool(
    "get_discovery_batch",
    {
      title: "Get Discovery Batch",
      description: "Retrieve a raw discovery inbox batch by UUID." + PERSISTENCE_NOTE,
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
        assertToolPermission(getAuth(extra), "get_discovery_batch");
        const batch = await getDiscoveryBatch(id);
        return jsonResult({ ok: true, found: Boolean(batch), batch });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to get discovery batch",
        );
      }
    },
  );

  server.registerTool(
    "list_pending_discovery_batches",
    {
      title: "List Pending Discovery Batches",
      description: "List unprocessed raw discovery inbox batches." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_pending_discovery_batches");
        const batches = await listPendingDiscoveryBatches(limit ?? 20);
        return jsonResult({ ok: true, count: batches.length, batches });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to list pending discovery batches",
        );
      }
    },
  );

  server.registerTool(
    "claim_discovery_batch",
    {
      title: "Claim Discovery Batch",
      description:
        "Atomically claim a pending discovery batch (pending → processing)." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        id: z.string().uuid().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "claim_discovery_batch");
        const batch = await claimDiscoveryBatch(id);
        return jsonResult({ ok: true, claimed: Boolean(batch), batch });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to claim discovery batch",
        );
      }
    },
  );

  server.registerTool(
    "complete_discovery_batch",
    {
      title: "Complete Discovery Batch",
      description:
        "Mark a processing discovery batch as completed after Python succeeds." +
        PERSISTENCE_NOTE,
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "complete_discovery_batch");
        const batch = await completeDiscoveryBatch(id);
        return jsonResult({ ok: true, completed: Boolean(batch), batch });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to complete discovery batch",
        );
      }
    },
  );

  server.registerTool(
    "fail_discovery_batch",
    {
      title: "Fail Discovery Batch",
      description:
        "Mark a processing discovery batch as failed and store a concise error. Raw payload is retained." +
        PERSISTENCE_NOTE,
      inputSchema: z.object({
        id: z.string().uuid(),
        error: z.string().min(1).max(4000),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, error }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "fail_discovery_batch");
        const batch = await failDiscoveryBatch(id, error);
        return jsonResult({ ok: true, failed: Boolean(batch), batch });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : "Failed to fail discovery batch",
        );
      }
    },
  );
}
