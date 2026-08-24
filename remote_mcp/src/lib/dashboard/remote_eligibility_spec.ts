/**
 * Shared remote-US nationwide classification specification.
 * Used by TypeScript classifiers, SQL predicates, and parity tests.
 */

/** v2 remote_scope values that exclude a posting from the default Remote US filter. */
export const V2_EXCLUDED_REMOTE_SCOPES = [
  "US_RESTRICTED",
  "HYBRID",
  "ONSITE",
  "NON_US",
  "UNKNOWN",
] as const;

export type V2ExcludedRemoteScope = (typeof V2_EXCLUDED_REMOTE_SCOPES)[number];

/** PostgreSQL ~* patterns (case-insensitive) shared with dashboard SQL. */
export const REMOTE_SQL_PATTERNS = {
  remoteStatusRemoteLike: "(remote|work from home|wfh|distributed|anywhere)",
  remoteStatusExclude: "(hybrid|onsite|on-site|in-office|non-us|international)",
  locationExcludeHybridNonUs:
    "(hybrid|onsite|on-site|canada|uk|united kingdom|europe|emea|apac|asia|india|australia|germany|france|mexico|latam|latin america|americas|international|non-us|non us)",
  locationExcludeRestricted:
    "(remote in|must be in|must live in|must reside|based in|located in|san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|los angeles|bay area|silicon valley|dallas|miami|portland|metro|metropolitan|area only|commutable|relocation|selected states|specific states|except specific|eastern time|california only|within state)",
  usStateNames:
    "\\y(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\\y",
  usStateAbbrev:
    "\\y(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\\y",
  usNationwide:
    "(united states|usa|u\\.s\\.|nationwide|fully remote|100% remote|remote us|us remote|remote \\(us\\)|remote \\(united states\\)|remote - us|remote - united states|anywhere in the us|work from anywhere)",
  locationRemoteLike: "(remote|work from home|wfh)",
  locationUsCountry: "(united states|usa|u\\.s\\.)",
} as const;

export type RemoteFilterEvidence = {
  remote_scope?: string | null;
  gpt_evaluation_id?: string | null;
  remote_status?: string | null;
  posting_location?: string | null;
  canonical_location?: string | null;
  location?: string | null;
};

function combinedLocation(input: RemoteFilterEvidence): string {
  return [input.posting_location, input.canonical_location, input.location]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function pgIlike(source: string, pattern: string): boolean {
  const jsPattern = pattern.replace(/\\y/g, "\\b");
  return new RegExp(jsPattern, "i").test(source);
}

/**
 * Mirrors the legacy branch of the dashboard SQL remote-US predicate (~* checks).
 */
export function matchesLegacyRemoteUsSqlLogic(
  remoteStatus: string | null | undefined,
  locationText: string | null | undefined,
): boolean {
  const status = String(remoteStatus ?? "");
  const loc = String(locationText ?? "");

  if (!pgIlike(status, REMOTE_SQL_PATTERNS.remoteStatusRemoteLike)) return false;
  if (pgIlike(status, REMOTE_SQL_PATTERNS.remoteStatusExclude)) return false;
  if (pgIlike(loc, REMOTE_SQL_PATTERNS.locationExcludeHybridNonUs)) return false;
  if (pgIlike(loc, REMOTE_SQL_PATTERNS.locationExcludeRestricted)) return false;
  if (pgIlike(loc, REMOTE_SQL_PATTERNS.usStateAbbrev)) return false;
  if (pgIlike(loc, REMOTE_SQL_PATTERNS.usStateNames)) return false;

  if (pgIlike(loc, REMOTE_SQL_PATTERNS.usNationwide)) return true;

  return (
    pgIlike(loc, REMOTE_SQL_PATTERNS.locationRemoteLike) &&
    pgIlike(loc, REMOTE_SQL_PATTERNS.locationUsCountry)
  );
}

/**
 * Full Remote US filter decision — mirrors dashboard_to_apply SQL remote predicate.
 */
export function matchesRemoteUsDashboardFilter(input: RemoteFilterEvidence): boolean {
  const scope = input.remote_scope ?? null;

  if (scope === "US_NATIONWIDE") return true;
  if (
    scope != null &&
    (V2_EXCLUDED_REMOTE_SCOPES as readonly string[]).includes(scope)
  ) {
    return false;
  }

  const useLegacy =
    input.gpt_evaluation_id == null || input.remote_scope == null;

  if (!useLegacy) return false;

  const locationText = combinedLocation(input);
  return matchesLegacyRemoteUsSqlLogic(input.remote_status, locationText);
}
