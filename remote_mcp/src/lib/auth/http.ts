import type { AuthInfo } from "@modelcontextprotocol/server";

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

function headerMismatchResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message },
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
}

type LegacyRoute = {
  method?: string;
  name?: string;
};

async function readLegacyRoute(req: Request): Promise<LegacyRoute> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !contentType.includes("text/plain")) {
    return {};
  }

  try {
    const body = (await req.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    return {
      method: typeof body?.method === "string" ? body.method : undefined,
      name: typeof body?.params?.name === "string" ? body.params.name : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Enforce per-tool permissions for both MCP protocol eras:
 * - 2026-07-28: route from Mcp-Method / Mcp-Name headers.
 * - legacy Streamable HTTP: route from the JSON-RPC request body.
 *
 * If modern headers and a legacy body are both present, reject mismatches before
 * authorization so a read-tool header cannot be paired with a destructive body.
 */
export async function enforceToolPermission(
  req: Request,
  auth: AuthInfo | undefined,
): Promise<Response | null> {
  if (req.method !== "POST") return null;

  const headerMethod = req.headers.get("mcp-method")?.trim();
  const headerName = req.headers.get("mcp-name")?.trim();
  const legacy = await readLegacyRoute(req);

  if (headerMethod && legacy.method && headerMethod !== legacy.method) {
    return headerMismatchResponse("Mcp-Method does not match the request body");
  }
  if (headerName && legacy.name && headerName !== legacy.name) {
    return headerMismatchResponse("Mcp-Name does not match the request body");
  }

  const method = headerMethod || legacy.method;
  if (method !== "tools/call") return null;

  if (headerMethod && !headerName) {
    return headerMismatchResponse("Mcp-Name is required for tools/call");
  }

  const toolName = headerName || legacy.name;
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
