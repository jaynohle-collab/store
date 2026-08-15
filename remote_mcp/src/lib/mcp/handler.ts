import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { SERVICE_NAME, SERVICE_VERSION, getMcpServerUrl, getProtectedResourceUrl } from "../config";
import { enforceToolPermission } from "../auth/http";
import { verifyTokenForMcp } from "../auth/jwt";
import { registerJobTools } from "./tools";

const mcpHandler = createMcpHandler(
  (server) => {
    registerJobTools(server);
  },
  {
    serverInfo: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
    },
    verboseLogs: false,
  },
);

async function permissionAwareHandler(req: Request): Promise<Response> {
  const denied = await enforceToolPermission(req, req.auth);
  if (denied) return denied;
  return mcpHandler(req);
}

const resourceUrl = getMcpServerUrl() ?? getProtectedResourceUrl().replace(/\/api\/mcp$/, "");

export const securedMcpHandler = withMcpAuth(permissionAwareHandler, verifyTokenForMcp, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
  resourceUrl: resourceUrl || undefined,
});
