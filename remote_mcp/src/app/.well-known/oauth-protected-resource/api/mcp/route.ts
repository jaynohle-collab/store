import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

import {
  SCOPES,
  getAuth0Issuer,
  getProtectedResourceUrl,
} from "@/lib/config";

export const runtime = "nodejs";

/**
 * Path-aware RFC 9728 metadata for resource https://…/api/mcp
 * Some MCP clients request /.well-known/oauth-protected-resource/api/mcp
 */
export function GET() {
  const issuer = getAuth0Issuer();
  if (!issuer) {
    return Response.json(
      { error: "AUTH0_ISSUER is not configured" },
      { status: 503 },
    );
  }

  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [issuer],
    resourceUrl: getProtectedResourceUrl(),
    additionalMetadata: {
      scopes_supported: [SCOPES.READ, SCOPES.WRITE, SCOPES.DELETE],
      bearer_methods_supported: ["header"],
    },
  });

  return Response.json(metadata, {
    headers: {
      "Cache-Control": "max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
