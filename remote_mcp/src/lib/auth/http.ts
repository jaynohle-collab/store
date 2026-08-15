import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { getProtectedResourceUrl } from "../config";
import { requiredPermissionForTool, hasPermission } from "./permissions";

function resourceMetadataUrl(req: Request): string {
  const configured = process.env.MCP_SERVER_URL?.replace(/\/$/, "");
  const origin = configured || new URL(req.url).origin;
  return `${origin}/.well-known/oauth-protected-resource`;
}

export function unauthorizedResponse(req: Request, description = "Unauthorized"): Response {
  const metadata = resourceMetadataUrl(req);
  return new Response(
    JSON.stringify({
      error: "invalid_token",
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="jay-job-mcp", resource_metadata="${metadata}"`,
      },
    },
  );
}

export function forbiddenResponse(req: Request, description: string): Response {
  const metadata = resourceMetadataUrl(req);
  return new Response(
    JSON.stringify({
      error: "insufficient_scope",
      error_description: description,
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${description}", resource_metadata="${metadata}"`,
      },
    },
  );
}

/**
 * Inspect JSON-RPC tools/call requests and enforce per-tool Auth0 permissions.
 * Clones the request body so the downstream MCP handler can still read it.
 */
export async function enforceToolPermission(
  req: Request,
  auth: AuthInfo | undefined,
): Promise<Response | null> {
  if (req.method !== "POST") return null;

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !contentType.includes("text/plain")) {
    return null;
  }

  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return null;
  }

  if (!body || typeof body !== "object") return null;
  const method = (body as { method?: unknown }).method;
  if (method !== "tools/call") return null;

  const params = (body as { params?: { name?: unknown } }).params;
  const toolName = typeof params?.name === "string" ? params.name : undefined;
  if (!toolName) return null;

  const required = requiredPermissionForTool(toolName);
  if (!required) return null;

  if (!hasPermission(auth, required)) {
    return forbiddenResponse(req, `Missing required permission: ${required}`);
  }

  return null;
}

export function mcpResourceIdentifier(): string {
  return getProtectedResourceUrl();
}
