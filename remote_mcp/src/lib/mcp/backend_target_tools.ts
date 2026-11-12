import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import { getDatabaseUrl } from "../config";
import { matchesBackendTarget } from "../db/backend_target";

const hex32Bytes = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const inputSchema = z.object({ challenge: hex32Bytes, expected_digest: hex32Bytes }).strict();

function requireWorkerIdentity(auth: AuthInfo | undefined): void {
  const clientId = auth?.clientId;
  const subject = auth?.extra?.sub;
  if (typeof clientId !== "string" || !clientId.trim() || clientId.trim() === "unknown"
      || typeof subject !== "string" || !subject.trim() || subject.trim() === "unknown") {
    throw new Error("authenticated_identity_required");
  }
}

function result(matches: boolean, isError = false) {
  const payload = { matches };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

export function registerBackendTargetTools(server: McpServer): void {
  server.registerTool("compare_backend_database_target", {
    title: "Compare Configured Backend Database Target",
    description: "Worker-only, nonce-bound comparison of the configured Neon endpoint and database. Returns only matches, never target details or a digest. Does not connect to SQL or prove a live session identity. Requires a fresh 32-byte hex challenge and the expected HMAC-SHA256 digest.",
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (args, extra) => {
    try {
      const auth = extra.http?.authInfo;
      assertToolPermission(auth, "compare_backend_database_target");
      requireWorkerIdentity(auth);
      const input = inputSchema.parse(args);
      const databaseUrl = getDatabaseUrl();
      if (!databaseUrl) return result(false, true);
      return result(matchesBackendTarget(databaseUrl, input.challenge, input.expected_digest));
    } catch {
      // Configuration, authorization and parser failures must not disclose any private values.
      return result(false, true);
    }
  });
}
