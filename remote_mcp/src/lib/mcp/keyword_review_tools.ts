import type { McpServer } from "@modelcontextprotocol/server";
import { assertToolPermission } from "../auth/permissions";
import { upsertKeywordReviewCandidates } from "../db/keyword_review";
import { upsertKeywordReviewCandidatesSchema } from "../discovery/keyword_review";

export function registerKeywordReviewTools(server: McpServer): void {
  server.registerTool("upsert_keyword_review_candidates", {
    title: "Save Keyword Review Candidates",
    description: "Store keyword-match review snapshots only. Listings remain unverified. Does not write canonical jobs, GPT evidence, inbox batches, or application state. Supply a stable run_id for retry-safe collection runs.",
    inputSchema: upsertKeywordReviewCandidatesSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    try {
      assertToolPermission(extra.http?.authInfo, "upsert_keyword_review_candidates");
      if (process.env.KEYWORD_REVIEW_ACTIVATION_APPROVED !== "true") {
        throw new Error("Keyword review writes are disabled until activation is explicitly approved.");
      }
      const result = { ok: true, ...await upsertKeywordReviewCandidates(args) };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Could not save keyword review" }], isError: true };
    }
  });
}
