import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";

import { assertToolPermission } from "../auth/permissions";
import {
  recordDiscoveryEvaluations,
  recordDiscoveryEvaluationsSchema,
} from "../db/discovery_gpt_evaluations";
import {
  computeDiscoveryDescriptionHashes,
  computeDiscoveryDescriptionHashesSchema,
} from "../discovery/description_hash";

const GPT_EVAL_NOTE =
  " GPT admission evidence only — stores qualified and rejected GPT evaluations." +
  " Supports gpt-fit-v1 and gpt-fit-v2 (remote_scope, direct_posting_url_verified," +
  " normalization_version, posting_status, posting_status_verified_at)." +
  " Does not create canonical jobs, submit inbox batches, or change application status." +
  " Separate from Python profile-v1 job_evaluations.";

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

export function registerDiscoveryGptEvaluationTools(server: McpServer): void {
  server.registerTool(
    "compute_discovery_description_hashes",
    {
      title: "Compute Discovery Description Hashes",
      description:
        "Read-only server-owned description hashing for discovery (1–20 items). " +
        "Returns sha256(normalized)[:16] lowercase hex using fingerprint-v1 normalization. " +
        "Does not store descriptions or write to the database. GPT must not invent hashes.",
      inputSchema: computeDiscoveryDescriptionHashesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "compute_discovery_description_hashes");
        const parsed = computeDiscoveryDescriptionHashesSchema.parse(args);
        const payload = computeDiscoveryDescriptionHashes(parsed);
        return jsonResult({
          ok: true,
          count: payload.results.length,
          ...payload,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to compute discovery description hashes",
        );
      }
    },
  );

  server.registerTool(
    "record_discovery_evaluations",
    {
      title: "Record Discovery Evaluations",
      description:
        "Persist 1–100 GPT discovery admission evaluations (gpt-fit-v1 / gpt-fit-v2)." +
        " Idempotent by client_evaluation_id." +
        GPT_EVAL_NOTE,
      inputSchema: recordDiscoveryEvaluationsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "record_discovery_evaluations");
        const parsed = recordDiscoveryEvaluationsSchema.parse(args);
        const payload = await recordDiscoveryEvaluations(parsed);
        return jsonResult({
          ok: true,
          count: payload.evaluations.length,
          evaluations: payload.evaluations.map((row) => ({
            evaluation_id: row.evaluation_id,
            client_evaluation_id: row.client_evaluation_id,
            ...row,
          })),
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to record discovery evaluations",
        );
      }
    },
  );
}
