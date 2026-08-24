import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  claimNextDiscoverySource,
  completeDiscoverySource,
  completeDiscoverySourceSchema,
  failDiscoverySource,
  failDiscoverySourceSchema,
  getDiscoveryRotation,
} from "../db/discovery_rotation";
import { getClaimTimeoutMs } from "../discovery/rotation";

const ROTATION_NOTE =
  " Rotation / checkpoint only — does not crawl sources, call GPT, score jobs, or persist job postings." +
  " fail_discovery_source retries the same source until DISCOVERY_SOURCE_MAX_ATTEMPTS (default 3);" +
  " at the limit the run is skipped_after_failures and the cursor auto-advances." +
  " complete_discovery_source always advances on success (including zero qualified_count) and resets failures." +
  " Stale claims consume one attempt; at max attempts the stale run is skipped_after_failures and claim_next advances to the next source in the same call.";

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

export function registerRotationTools(server: McpServer): void {
  server.registerTool(
    "get_discovery_rotation",
    {
      title: "Get Discovery Rotation",
      description:
        "Return ordered discovery sources, the current cursor source, cycle ID, and latest run status." +
        ROTATION_NOTE,
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
        assertToolPermission(getAuth(extra), "get_discovery_rotation");
        const snapshot = await getDiscoveryRotation();
        return jsonResult({
          ok: true,
          cycle_id: snapshot.cycle_id,
          current_source_key: snapshot.current_source_key,
          active_run_id: snapshot.active_run_id,
          enabled_sources: snapshot.enabled_sources,
          sources: snapshot.sources,
          latest_run: snapshot.latest_run,
          source_failure_counts: snapshot.source_failure_counts,
          max_attempts: snapshot.max_attempts,
          claim_timeout_ms: getClaimTimeoutMs(),
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to get discovery rotation",
        );
      }
    },
  );

  server.registerTool(
    "claim_next_discovery_source",
    {
      title: "Claim Next Discovery Source",
      description:
        "Atomically claim the current discovery source cursor for one search run." +
        " Returns run_id, cycle_id, source, and checkpoint. Prevents concurrent active claims;" +
        " recovers stale claims after the configured timeout." +
        ROTATION_NOTE,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "claim_next_discovery_source");
        const claim = await claimNextDiscoverySource();
        return jsonResult({ ok: true, ...claim });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to claim discovery source",
        );
      }
    },
  );

  server.registerTool(
    "complete_discovery_source",
    {
      title: "Complete Discovery Source",
      description:
        "Mark a claimed discovery source run completed with counters and optional checkpoint," +
        " then advance to the next enabled source (or wrap to a new cycle starting at ashby)." +
        ROTATION_NOTE,
      inputSchema: completeDiscoverySourceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "complete_discovery_source");
        const parsed = completeDiscoverySourceSchema.parse(args);
        const result = await completeDiscoverySource(parsed);
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to complete discovery source",
        );
      }
    },
  );

  server.registerTool(
    "fail_discovery_source",
    {
      title: "Fail Discovery Source",
      description:
        "Mark a claimed discovery source run failed with a sanitized error." +
        " Retries the same source until max attempts, then skips with skipped_after_failures and advances." +
        ROTATION_NOTE,
      inputSchema: failDiscoverySourceSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "fail_discovery_source");
        const parsed = failDiscoverySourceSchema.parse(args);
        const result = await failDiscoverySource(parsed);
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Failed to fail discovery source",
        );
      }
    },
  );
}
