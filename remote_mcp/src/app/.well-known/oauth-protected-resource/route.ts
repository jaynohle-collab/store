import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

import {
  SCOPES,
  getAuth0Issuer,
  getMcpServerUrl,
  getProtectedResourceUrl,
} from "@/lib/config";

export const runtime = "nodejs";

function buildMetadata(req: Request) {
  const issuer = getAuth0Issuer();
  if (!issuer) {
    return Response.json(
      { error: "AUTH0_ISSUER is not configured" },
      { status: 503 },
    );
  }

  const configuredResource = getProtectedResourceUrl();
  const resourceFromRequest = (() => {
    const publicBase = getMcpServerUrl();
    if (publicBase) return `${publicBase}/api/mcp`;
    const url = new URL(req.url);
    return `${url.origin}/api/mcp`;
  })();

  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [issuer],
    resourceUrl: configuredResource || resourceFromRequest,
    additionalMetadata: {
      scopes_supported: [SCOPES.READ, SCOPES.WRITE, SCOPES.DELETE],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "Jay Job MCP is a persistence boundary for job records. It does not score or deduplicate jobs.",
    },
  });

  return Response.json(metadata, {
    headers: {
      "Cache-Control": "max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export function GET(req: Request) {
  return buildMetadata(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
