/**
 * Local calendar-day bounds for dashboard "today" metrics.
 * Stored timestamps remain TIMESTAMPTZ; only the day window is timezone-aware.
 */

export function getDashboardTimeZone(): string {
  return process.env.DASHBOARD_TIME_ZONE?.trim() || "America/Los_Angeles";
}

function formatInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** UTC instant of local midnight for YYYY-MM-DD in the given IANA timezone. */
export function localMidnightToUtc(ymd: string, timeZone: string): Date {
  const target = `${ymd}T00:00:00`;
  let lo = Date.parse(`${ymd}T00:00:00.000Z`) - 36 * 3600_000;
  let hi = Date.parse(`${ymd}T00:00:00.000Z`) + 36 * 3600_000;
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const stamped = formatInTimeZone(new Date(mid), timeZone);
    if (stamped < target) lo = mid + 1;
    else hi = mid;
  }
  return new Date(hi);
}

export function getLocalDayBounds(
  timeZone = getDashboardTimeZone(),
  now = new Date(),
): { start: Date; end: Date; localDate: string; timeZone: string } {
  const stamped = formatInTimeZone(now, timeZone);
  const localDate = stamped.slice(0, 10);
  const start = localMidnightToUtc(localDate, timeZone);
  const end = localMidnightToUtc(addCalendarDays(localDate, 1), timeZone);
  return { start, end, localDate, timeZone };
}

export function getActiveScoringVersion(): string {
  return process.env.DASHBOARD_SCORING_VERSION?.trim() || "profile-v1";
}

export function getActiveProfileVersion(): string {
  return process.env.DASHBOARD_PROFILE_VERSION?.trim() || "jay-ai-v1";
}
