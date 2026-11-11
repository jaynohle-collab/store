import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assertToolPermission } from '../auth/permissions';
import { claimHaikuAttempt, reserveHaikuAttempt } from '../db/haiku_budget';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
function owner(auth: AuthInfo | undefined): string {
  const sub = auth?.extra?.sub;
  if (!auth || typeof sub !== 'string' || !sub.trim() || !auth.clientId || auth.clientId === 'unknown') {
    throw new Error('authenticated_identity_required');
  }
  return JSON.stringify([auth.clientId, sub]);
}
function result(payload: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
export function registerHaikuBudgetTools(server: McpServer): void {
  server.registerTool('reserve_haiku_attempt', {
    description: 'Worker-only durable Haiku attempt reservation. Fixed 50 attempts per Los Angeles day, shared monthly application allowance. No refunds; each retry needs a new reservation. Disabled until reviewed.',
    inputSchema: z.object({ request_sha256: digestSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const auth = extra.http?.authInfo;
      assertToolPermission(auth, 'reserve_haiku_attempt');
      const parsed = z.object({ request_sha256: digestSchema }).strict().parse(args);
      return result(await reserveHaikuAttempt(owner(auth), parsed.request_sha256));
    } catch { return result({ allowed: false, reason: 'reservation_failed' }, true); }
  });
  server.registerTool('claim_haiku_attempt', {
    description: 'Worker-only one-use claim immediately before dispatch. Owner-bound, expires, no refunds. Client must verify returned policy and dispatch deadline before calling Anthropic.',
    inputSchema: z.object({ reservation_id: z.uuid(), request_sha256: digestSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const auth = extra.http?.authInfo;
      assertToolPermission(auth, 'claim_haiku_attempt');
      const parsed = z.object({ reservation_id: z.uuid(), request_sha256: digestSchema }).strict().parse(args);
      return result(await claimHaikuAttempt(owner(auth), parsed.reservation_id, parsed.request_sha256));
    } catch { return result({ allowed: false, reason: 'claim_failed' }, true); }
  });
}
