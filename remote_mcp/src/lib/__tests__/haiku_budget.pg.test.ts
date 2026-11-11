import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const digest = 'a'.repeat(64);
let db: PGlite;
async function reserve(limit = 30000000, owner = 'worker') {
  const r = await db.query<{ result: Record<string, any> }>('SELECT reserve_haiku_attempt($1,$2,$3) AS result', [owner, limit, digest]);
  return r.rows[0].result;
}
async function claim(id: string, owner = 'worker', hash = digest) {
  const r = await db.query<{ result: Record<string, any> }>('SELECT claim_haiku_attempt($1,$2,$3) AS result', [owner, id, hash]);
  return r.rows[0].result;
}
describe('durable Haiku budget (local PGlite, single connection)', () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec("CREATE TABLE test_clock (ts timestamptz); INSERT INTO test_clock VALUES ('2026-11-11 20:00:00Z'); CREATE FUNCTION test_now() RETURNS timestamptz LANGUAGE SQL AS 'SELECT ts FROM test_clock';");
    // Only the test copy substitutes time. Production exposes no clock override.
    await db.exec(readFileSync('migrations/017_haiku_attempt_budget.sql', 'utf8').replaceAll('clock_timestamp()', 'test_now()'));
  });
  afterEach(async () => { await db.close(); });
  it('serializes 75 concurrent-like requests to exactly 50, shared across identities', async () => {
    const results = await Promise.all(Array.from({ length: 75 }, (_, i) => reserve(30000000, `worker-${i}`)));
    expect(results.filter(r => r.allowed)).toHaveLength(50);
    expect(results.filter(r => !r.allowed).every(r => r.reason === 'daily_limit')).toBe(true);
    expect((await db.query('SELECT reserved_micro_usd FROM haiku_monthly_budget')).rows).toEqual([{ reserved_micro_usd: 250000 }]);
  });
  it('monthly allowance is atomic and no refunds occur on unclaimed or expired reservations', async () => {
    const first = await reserve(10000);
    await reserve(10000);
    expect(await reserve(10000)).toMatchObject({ allowed: false, reason: 'monthly_limit', used: 2 });
    await db.query("UPDATE haiku_attempt_reservations SET reserved_at = test_now() - interval '2 minutes', expires_at = test_now() - interval '1 minute' WHERE reservation_id=$1", [first.reservation_id]);
    expect((await claim(first.reservation_id)).allowed).toBe(false);
    expect((await reserve(10000)).allowed).toBe(false);
  });
  it('binds digest and owner, permits one claim, returns fixed policy and short dispatch window', async () => {
    const r = await reserve();
    expect((await claim(r.reservation_id, 'other')).allowed).toBe(false);
    expect((await claim(r.reservation_id, 'worker', 'b'.repeat(64))).allowed).toBe(false);
    const c = await claim(r.reservation_id);
    expect(c).toMatchObject({ allowed: true, model: 'claude-haiku-5-5', max_request_bytes: 16000, max_output_tokens: 2048, reserved_micro_usd: 5000, policy_version: 'haiku-5-5-v1' });
    expect(Date.parse(c.dispatch_before) - Date.parse(c.server_time)).toBeLessThanOrEqual(5000);
    expect(Date.parse(c.dispatch_before)).toBeLessThanOrEqual(Date.parse(c.expires_at));
    expect((await claim(r.reservation_id)).allowed).toBe(false);
    expect((await reserve()).used).toBe(2);
  });
  it('denies invalid server allowance and hard maximum over $30', async () => {
    for (const limit of [0, -1, 30000001]) expect((await reserve(limit)).allowed).toBe(false);
    expect((await reserve()).used).toBe(1);
  });
  it('uses LA midnight, denies near reset, and resets day without resetting the month', async () => {
    await db.exec("UPDATE test_clock SET ts = '2026-11-12 07:59:40Z'");
    const r = await reserve();
    expect(r.budget_day).toBe('2026-11-11');
    expect(Date.parse(r.reset_at)).toBe(Date.parse('2026-11-12T08:00:00Z'));
    await db.exec("UPDATE test_clock SET ts = '2026-11-12 07:59:51Z'");
    expect((await reserve()).reason).toBe('day_reset_pending');
    expect((await claim(r.reservation_id)).allowed).toBe(false);
    await db.exec("UPDATE test_clock SET ts = '2026-11-12 08:00:01Z'");
    expect(await reserve()).toMatchObject({ allowed: true, budget_day: '2026-11-12', used: 1 });
    expect((await db.query('SELECT reserved_micro_usd FROM haiku_monthly_budget')).rows).toEqual([{ reserved_micro_usd: 10000 }]);
  });
  it('handles DST midnight correctly and rolls monthly allowance at LA month boundary', async () => {
    await db.exec("UPDATE test_clock SET ts = '2026-03-08 08:00:00Z'");
    const spring = await reserve();
    expect(Date.parse(spring.reset_at) - Date.parse('2026-03-08T08:00:00Z')).toBe(23 * 3600000);
    await db.exec("UPDATE test_clock SET ts = '2026-12-01 07:00:00Z'");
    expect((await reserve(5000)).allowed).toBe(true);
    expect((await reserve(5000)).reason).toBe('monthly_limit');
    await db.exec("UPDATE test_clock SET ts = '2026-12-01 08:00:01Z'");
    expect(await reserve(5000)).toMatchObject({ allowed: true, budget_day: '2026-12-01', used: 1 });
  });
  it('only grants one of many simultaneous-like claims', async () => {
    const r = await reserve();
    const claims = await Promise.all(Array.from({ length: 10 }, () => claim(r.reservation_id)));
    expect(claims.filter(c => c.allowed)).toHaveLength(1);
  });
  it('rolls back both counters when reservation insertion fails', async () => {
    await db.exec("ALTER TABLE haiku_attempt_reservations ADD CONSTRAINT force_failure CHECK (false)");
    await expect(reserve()).rejects.toThrow();
    expect((await db.query('SELECT * FROM haiku_daily_budget')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM haiku_monthly_budget')).rows).toHaveLength(0);
  });
});
