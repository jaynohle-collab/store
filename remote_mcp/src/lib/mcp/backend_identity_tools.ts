import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { assertToolPermission } from "../auth/permissions";
import { getBackendDatabaseRole } from "../db/backend_identity";

const emptyInputSchema = z.object({}).strict();

function requireWorkerIdentity(auth: AuthInfo | undefined): void {
  const clientId = auth?.clientId;
  const subject = auth?.extra?.sub;
  if (typeof clientId !== "string" || !clientId.trim() || clientId.trim() === "unknown"
      || typeof subject !== "string" || !subject.trim() || subject.trim() === "unknown") {
    throw new Error("authenticated_identity_required");
  }
}

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

export function registerBackendIdentityTools(server: McpServer): void {
  server.registerTool("get_backend_database_role", {
    title: "Read Backend Database Role",
    description: "Worker-only read of the current PostgreSQL role used by this backend. Returns only the role name, not credentials, connection strings, configuration values, or stored application data. Accepts no query or other input.",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (args, extra) => {
    try {
      const auth = extra.http?.authInfo;
      assertToolPermission(auth, "get_backend_database_role");
      requireWorkerIdentity(auth);
      emptyInputSchema.parse(args);
      return result({ ok: true, ...await getBackendDatabaseRole() });
    } catch {
      // Driver/auth/validation errors may include private values. Never echo or log them.
      return result({ ok: false, error: "backend_identity_unavailable" }, true);
    }
  });
}
