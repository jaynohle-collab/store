import type { AuthInfo } from "@modelcontextprotocol/server";

import { TOOL_PERMISSIONS, type JobScope } from "../config";

export function extractPermissions(payload: Record<string, unknown>): string[] {
  const permissions = new Set<string>();

  const permissionClaim = payload.permissions;
  if (Array.isArray(permissionClaim)) {
    for (const value of permissionClaim) {
      if (typeof value === "string" && value.trim()) {
        permissions.add(value.trim());
      }
    }
  }

  const scopeClaim = payload.scope;
  if (typeof scopeClaim === "string") {
    for (const value of scopeClaim.split(/\s+/)) {
      if (value.trim()) permissions.add(value.trim());
    }
  }

  const scopesClaim = payload.scopes;
  if (Array.isArray(scopesClaim)) {
    for (const value of scopesClaim) {
      if (typeof value === "string" && value.trim()) {
        permissions.add(value.trim());
      }
    }
  }

  return Array.from(permissions);
}

export function hasPermission(auth: AuthInfo | undefined, required: JobScope): boolean {
  if (!auth) return false;
  return auth.scopes.includes(required);
}

export function requiredPermissionForTool(toolName: string): JobScope | undefined {
  return TOOL_PERMISSIONS[toolName];
}

export function assertToolPermission(auth: AuthInfo | undefined, toolName: string): void {
  const required = requiredPermissionForTool(toolName);
  if (!required) return;
  if (!hasPermission(auth, required)) {
    const error = new Error(`Missing required permission: ${required}`);
    error.name = "ForbiddenError";
    throw error;
  }
}
