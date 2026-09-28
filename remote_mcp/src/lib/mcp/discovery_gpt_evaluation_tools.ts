import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";

import { assertToolPermission } from "../auth/permissions";
import {
  getDiscoveryEvaluationByClientIdSchema,
  getDiscoveryGptEvaluationByClientId,
  lookupDiscoveryEvaluationStates,
  lookupDiscoveryEvaluationStatesSchema,
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
    "get_discovery_evaluation_by_client_id",
    {
      title: "Get Discovery Evaluation By Client ID",
      description:
        "Read-only lookup of a stored GPT discovery evaluation by deterministic" +
        " client_evaluation_id. Used by automatic discovery to reuse evidence after" +
        " a crash between persist and pending-row completion. Does not create," +
        " update, or delete evaluations." +
        GPT_EVAL_NOTE,
      inputSchema: getDiscoveryEvaluationByClientIdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_discovery_evaluation_by_client_id");
        const parsed = getDiscoveryEvaluationByClientIdSchema.parse(args);
        const evaluation = await getDiscoveryGptEvaluationByClientId(
          parsed.client_evaluation_id,
        );
        return jsonResult({
          ok: true,
          found: evaluation != null,
          evaluation,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to get discovery evaluation by client id",
        );
      }
    },
  );

  server.registerTool(
    "lookup_discovery_evaluation_states",
    {
      title: "Lookup Discovery Evaluation States",
      description:
        "Read-only: latest stored GPT evidence for up to 200 lightweight candidates" +
        " (matched by normalized URL or source + external_job_id) for one evaluation" +
        " version and persona generation (profile_id + profile_version). Reports" +
        " whether that evidence is already attached to an inbox batch. Used to rank" +
        " new/changed listings before full fetches. Does not score or write." +
        GPT_EVAL_NOTE,
      inputSchema: lookupDiscoveryEvaluationStatesSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "lookup_discovery_evaluation_states");
        const parsed = lookupDiscoveryEvaluationStatesSchema.parse(args);
        const payload = await lookupDiscoveryEvaluationStates(parsed);
        return jsonResult({ ok: true, count: payload.states.length, ...payload });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to lookup discovery evaluation states",
        );
      }
    },
  );

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
