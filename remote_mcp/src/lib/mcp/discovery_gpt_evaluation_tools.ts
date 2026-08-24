import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";

import { assertToolPermission } from "../auth/permissions";
import {
  recordDiscoveryEvaluations,
  recordDiscoveryEvaluationsSchema,
} from "../db/discovery_gpt_evaluations";

const GPT_EVAL_NOTE =
  " GPT admission evidence only — stores qualified and rejected GPT evaluations." +
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
    "record_discovery_evaluations",
    {
      title: "Record Discovery Evaluations",
      description:
        "Persist 1–100 GPT discovery admission evaluations (gpt-fit-v1)." +
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
