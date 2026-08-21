/** Deterministic text/URL normalization for discovery preflight (mirrors Python). */

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

const COMMON_JOB_WORDS = new Set([
  "and",
  "for",
  "with",
  "in",
  "to",
  "of",
  "the",
  "on",
  "a",
  "an",
  "at",
  "by",
  "from",
  "as",
  "or",
  "role",
  "position",
  "opening",
  "hiring",
  "opportunity",
  "job",
  "jobs",
  "opportunities",
]);

const COMPANY_SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
];

export function normalizeFingerprintText(value: string | null | undefined): string {
  if (!value) return "";
  let normalized = value.toLowerCase().replace(/&/g, " and ");
  normalized = normalized.replace(/[^\w\s]+/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

export function normalizeCompanyKey(companyName: string | null | undefined): string {
  let normalized = normalizeFingerprintText(companyName);
  for (const suffix of COMPANY_SUFFIXES) {
    normalized = normalized.replace(new RegExp(`\\b${suffix}\\b`, "g"), "");
  }
  return normalized.replace(/\s+/g, " ").trim();
}

export function normalizeTitleKey(title: string | null | undefined): string {
  const normalized = normalizeFingerprintText(title);
  const tokens = normalized.split(/\s+/).filter((token) => token && !COMMON_JOB_WORDS.has(token));
  return tokens.join(" ");
}

export function normalizeLocationKey(location: string | null | undefined): string {
  return normalizeFingerprintText(location);
}

/** Match Python urllib.parse.quote_plus (default safe='') for query components. */
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonicalize a job URL for posting identity matching (Python-compatible). */
export function normalizeJobUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const light = raw.replace(/\/+$/, "").toLowerCase();
    return light || null;
  }

  if (!parsed.protocol || !parsed.host) {
    const light = raw.replace(/\/+$/, "").toLowerCase();
    return light || null;
  }

  const scheme = parsed.protocol.toLowerCase().replace(/:$/, "");
  const netloc = parsed.host.toLowerCase();
  let path = parsed.pathname || "";
  if (path !== "/" && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  const kept: string[] = [];
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
      kept.push(`${quotePlus(key)}=${quotePlus(value)}`);
    }
  });
  const query = kept.join("&");
  const href = `${scheme}://${netloc}${path}${query ? `?${query}` : ""}`;
  return href || null;
}
