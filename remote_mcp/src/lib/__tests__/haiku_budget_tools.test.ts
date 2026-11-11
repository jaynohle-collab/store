import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sql = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ getSql: () => sql }));
import { registerHaikuBudgetTools } from '@/lib/mcp/haiku_budget_tools';
import { reviewedHaikuMonthlyLimit } from '@/lib/db/haiku_budget';
const digest = 'a'.repeat(64);
const id = '2f0e68ac-79ba-4da2-a3c2-af1fb663030e';
const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
registerHaikuBudgetTools({ registerTool: (name: string, _config: unknown, handler: any) => { handlers[name] = handler; } } as unknown as McpServer);
const auth = (scopes = ['jobs:worker'], sub: unknown = 'worker') => ({ http: { authInfo: { token: 'test', clientId: 'client', scopes, extra: { sub } } } });
describe('Haiku MCP authorization and runtime kill switch', () => {
  beforeEach(() => {
    sql.mockReset().mockResolvedValue([{ result: { allowed: true } }]);
    vi.stubEnv('HAIKU_BUDGET_CONTROLS_APPROVED', 'true');
    vi.stubEnv('HAIKU_MONTHLY_LIMIT_MICRO_USD', '30000000');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('rejects unauthenticated, non-worker and missing subject without DB access', async () => {
    for (const extra of [{}, auth(['jobs:read', 'jobs:write']), auth(['jobs:worker'], null)]) {
      for (const name of Object.keys(handlers)) {
        expect((await handlers[name]({ request_sha256: digest, ...(name.startsWith('claim') ? { reservation_id: id } : {}) }, extra)).structuredContent.allowed).toBe(false);
      }
    }
    expect(sql).not.toHaveBeenCalled();
  });
  it('rejects caller day, cap, owner or malformed digest', async () => {
    for (const override of [{ owner: 'other' }, { budget_day: '2026-01-01' }, { cap: 500 }, { request_sha256: 'invalid' }]) {
      expect((await handlers.reserve_haiku_attempt({ request_sha256: digest, ...override }, auth())).structuredContent.allowed).toBe(false);
    }
    expect(sql).not.toHaveBeenCalled();
  });
  it('binds identity from verified auth and passes digest to SQL', async () => {
    await handlers.reserve_haiku_attempt({ request_sha256: digest }, auth());
    expect(sql.mock.calls[0].slice(1)).toEqual(['["client","worker"]', 30000000, digest]);
    await handlers.claim_haiku_attempt({ reservation_id: id, request_sha256: digest }, auth());
    expect(sql.mock.calls[1].slice(1)).toEqual(['["client","worker"]', id, digest]);
  });
  it('fails closed on disabled, malformed or oversized monthly config for both tools', async () => {
    for (const value of ['', '0', '30000001', 'NaN', '1e6', '-5000', '5000.5']) {
      vi.stubEnv('HAIKU_MONTHLY_LIMIT_MICRO_USD', value);
      expect(reviewedHaikuMonthlyLimit()).toBeNull();
      expect((await handlers.reserve_haiku_attempt({ request_sha256: digest }, auth())).structuredContent.allowed).toBe(false);
      expect((await handlers.claim_haiku_attempt({ reservation_id: id, request_sha256: digest }, auth())).structuredContent.allowed).toBe(false);
    }
    vi.stubEnv('HAIKU_MONTHLY_LIMIT_MICRO_USD', '30000000');
    vi.stubEnv('HAIKU_BUDGET_CONTROLS_APPROVED', 'false');
    expect(reviewedHaikuMonthlyLimit()).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });
  it('fails closed on uncertain database errors and missing responses', async () => {
    sql.mockRejectedValueOnce(new Error('timeout'));
    expect((await handlers.reserve_haiku_attempt({ request_sha256: digest }, auth())).structuredContent.allowed).toBe(false);
    sql.mockResolvedValueOnce([]);
    expect((await handlers.claim_haiku_attempt({ reservation_id: id, request_sha256: digest }, auth())).structuredContent.allowed).toBe(false);
  });
});
