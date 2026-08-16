import { Auth0Client } from "@auth0/nextjs-auth0/server";

/**
 * Dashboard Regular Web Application session client (Auth0 nextjs-auth0 v4).
 * Separate from MCP M2M / bearer JWT validation (AUTH0_ISSUER + AUTH0_AUDIENCE).
 *
 * Required env (placeholders only in repo):
 *   AUTH0_DOMAIN
 *   AUTH0_CLIENT_ID
 *   AUTH0_CLIENT_SECRET
 *   AUTH0_SECRET
 *   APP_BASE_URL
 */
export const auth0 = new Auth0Client();
