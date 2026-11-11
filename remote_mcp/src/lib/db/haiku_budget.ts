import { getSql } from './client';

/** Fail closed: migration alone cannot enable paid inference. */
export function reviewedHaikuMonthlyLimit(): number | null {
  const value = process.env.HAIKU_MONTHLY_LIMIT_MICRO_USD ?? '';
  if (process.env.HAIKU_BUDGET_CONTROLS_APPROVED !== 'true' || !/^[0-9]+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 5000 && limit <= 30000000 ? limit : null;
}

export async function reserveHaikuAttempt(owner: string, digest: string) {
  const limit = reviewedHaikuMonthlyLimit();
  if (limit === null) return { allowed: false, reason: 'disabled' };
  const rows = await getSql()`SELECT reserve_haiku_attempt(${owner}, ${limit}::bigint, ${digest}) AS result`;
  if (!rows[0]?.result) throw new Error('budget_response_missing');
  return rows[0].result as Record<string, unknown>;
}

export async function claimHaikuAttempt(owner: string, reservation: string, digest: string) {
  if (reviewedHaikuMonthlyLimit() === null) return { allowed: false, reason: 'disabled' };
  const rows = await getSql()`SELECT claim_haiku_attempt(${owner}, ${reservation}::uuid, ${digest}) AS result`;
  if (!rows[0]?.result) throw new Error('budget_response_missing');
  return rows[0].result as Record<string, unknown>;
}
