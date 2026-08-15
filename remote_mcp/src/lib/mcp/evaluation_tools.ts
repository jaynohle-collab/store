import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import {
  getLatestJobEvaluation,
  listJobEvaluations,
  saveJobEvaluation,
  saveJobEvaluationSchema,
} from "../db/evaluations";

const PERSISTENCE_NOTE =
  " Persistence layer only — does not score jobs or decide recommendations.";

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

export function registerEvaluationTools(server: McpServer): void {
  server.registerTool(
    "save_job_evaluation",
    {
      title: "Save Job Evaluation",
      description:
        "Persist a Python-computed candidate match evaluation for a posting." + PERSISTENCE_NOTE,
      inputSchema: saveJobEvaluationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        assertToolPermission(getAuth(extra), "save_job_evaluation");
        const parsed = saveJobEvaluationSchema.parse(args);
        const evaluation = await saveJobEvaluation(parsed);
        return jsonResult({ ok: true, id: evaluation.id, evaluation });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to save evaluation");
      }
    },
  );

  server.registerTool(
    "get_latest_job_evaluation",
    {
      title: "Get Latest Job Evaluation",
      description: "Return the most recent evaluation for a posting." + PERSISTENCE_NOTE,
      inputSchema: z.object({ posting_id: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ posting_id }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "get_latest_job_evaluation");
        const evaluation = await getLatestJobEvaluation(posting_id);
        return jsonResult({ ok: true, found: Boolean(evaluation), evaluation });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to get evaluation");
      }
    },
  );

  server.registerTool(
    "list_job_evaluations",
    {
      title: "List Job Evaluations",
      description: "List historical evaluations for a posting (newest first)." + PERSISTENCE_NOTE,
      inputSchema: z.object({
        posting_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ posting_id, limit }, extra) => {
      try {
        assertToolPermission(getAuth(extra), "list_job_evaluations");
        const evaluations = await listJobEvaluations(posting_id, limit ?? 50);
        return jsonResult({ ok: true, count: evaluations.length, evaluations });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Failed to list evaluations");
      }
    },
  );
}
