/**
 * Deterministic job-posting URL classification for discovery admission.
 * Obviously invalid listing/careers pages must not QUALIFY.
 * Uncertain URLs are UNKNOWN and require GPT verification.
 * MISSING_POSTING_ID applies only to recognized ATS hosts/patterns.
 * Prefer UNKNOWN over a false rejection when certainty is insufficient.
 * Never invents a posting URL and does not crawl/follow redirects.
 */

export const POSTING_URL_CLASSES = [
  "DIRECT_POSTING",
  "CAREERS_HOME",
  "JOBS_LANDING",
  "SEARCH_OR_LISTING",
  "CATEGORY",
  "MISSING_POSTING_ID",
  "UNKNOWN",
] as const;

export type PostingUrlClass = (typeof POSTING_URL_CLASSES)[number];

export type PostingUrlClassification = {
  url_class: PostingUrlClass;
  is_obviously_invalid: boolean;
  reason: string;
};

const SEARCH_QUERY_KEYS = new Set([
  "query",
  "q",
  "search",
  "keywords",
  "keyword",
  "department",
  "team",
  "page",
  "offset",
  "filter",
]);

const JOB_ID_QUERY_KEYS = new Set([
  "gh_jid",
  "jobid",
  "job_id",
  "jid",
  "reqid",
  "req_id",
  "requisitionid",
  "requisition_id",
  "requisition",
  "ashby_jid",
  "posting_id",
  "postingid",
  "token",
]);

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path || "/";
}

function pathSegments(pathname: string): string[] {
  return stripTrailingSlash(pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

function hasJobIdQuery(url: URL): boolean {
  return [...url.searchParams.entries()].some(
    ([key, value]) => JOB_ID_QUERY_KEYS.has(key.toLowerCase()) && value.trim().length > 0,
  );
}

function hasSearchQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => SEARCH_QUERY_KEYS.has(key.toLowerCase()));
}

function isRecognizedAtsHost(host: string): boolean {
  return (
    host.includes("ashbyhq.com") ||
    host.includes("ashby.com") ||
    host.includes("greenhouse.io") ||
    host.includes("greenhouse.com") ||
    host.includes("lever.co") ||
    host.includes("myworkdayjobs.com") ||
    host.includes("workday.com")
  );
}

function isBareCareersHome(segments: string[]): boolean {
  if (segments.length === 1) {
    return ["careers", "opportunities", "openings"].includes(segments[0]);
  }
  return (
    segments.length === 2 &&
    ["careers", "jobs"].includes(segments[0]) &&
    ["home", "index", "overview"].includes(segments[1])
  );
}

function isBareJobsLanding(segments: string[]): boolean {
  if (segments.length === 1) {
    return ["jobs", "job", "positions"].includes(segments[0]);
  }
  return /^(careers|jobs)\/(all|open|list)?$/.test(segments.join("/"));
}

function isSearchPath(segments: string[]): boolean {
  return segments.some((segment) => ["search", "results", "listings", "listing"].includes(segment));
}

function isCategoryPath(segments: string[]): boolean {
  const joined = segments.join("/");
  if (/\/(department|team|category|categories|location|locations|city|cities)\//.test(`/${joined}/`)) {
    return true;
  }
  return (
    segments.length >= 2 &&
    ["department", "team", "category", "location", "city", "role-type"].includes(segments[0])
  );
}

function classifyRecognizedAts(
  host: string,
  pathname: string,
  segments: string[],
  url: URL,
): PostingUrlClassification {
  if (host.includes("ashbyhq.com") || host.includes("ashby.com")) {
    if (hasJobIdQuery(url) && segments.length >= 1) {
      return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "ashby job-id query" };
    }
    if (segments.length >= 2 && segments[0] !== "api") {
      const postingId = segments[segments.length - 1];
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        postingId,
      );
      const slug = postingId.length >= 8 && !["jobs", "careers", "search"].includes(postingId);
      if (uuid || slug) {
        return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "ashby posting path" };
      }
      return {
        url_class: "MISSING_POSTING_ID",
        is_obviously_invalid: true,
        reason: "ashby URL missing posting identifier",
      };
    }
    return { url_class: "JOBS_LANDING", is_obviously_invalid: true, reason: "ashby org landing" };
  }

  if (host.includes("greenhouse.io") || host.includes("greenhouse.com")) {
    if (hasJobIdQuery(url)) {
      return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "greenhouse job-id query" };
    }
    const jobsIdx = segments.indexOf("jobs");
    if (jobsIdx >= 0 && segments[jobsIdx + 1] && /^\d+$/.test(segments[jobsIdx + 1])) {
      return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "greenhouse job id" };
    }
    if (segments.includes("embed") || pathname.toLowerCase().includes("job_app")) {
      if (url.searchParams.get("token") || url.searchParams.get("gh_jid")) {
        return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "greenhouse embed token" };
      }
    }
    if (segments.length <= 1 || (segments.length === 2 && segments[1] === "jobs")) {
      return { url_class: "JOBS_LANDING", is_obviously_invalid: true, reason: "greenhouse board landing" };
    }
    return {
      url_class: "MISSING_POSTING_ID",
      is_obviously_invalid: true,
      reason: "greenhouse URL without numeric job id",
    };
  }

  if (host.includes("lever.co")) {
    if (hasJobIdQuery(url) && segments.length >= 1) {
      return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "lever job-id query" };
    }
    if (segments.length >= 2) {
      const id = segments[1];
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        id.length >= 12
      ) {
        return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "lever posting id" };
      }
    }
    if (segments.length <= 1) {
      return { url_class: "JOBS_LANDING", is_obviously_invalid: true, reason: "lever company landing" };
    }
    return {
      url_class: "MISSING_POSTING_ID",
      is_obviously_invalid: true,
      reason: "lever URL missing posting id",
    };
  }

  if (hasJobIdQuery(url)) {
    return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "workday job-id query" };
  }
  const jobIdx = segments.indexOf("job");
  if (jobIdx >= 0) {
    const afterJob = segments.slice(jobIdx + 1).join("/");
    if (afterJob.length >= 3) {
      return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "workday job path" };
    }
  }
  if (segments.length <= 2) {
    return { url_class: "JOBS_LANDING", is_obviously_invalid: true, reason: "workday careers landing" };
  }
  return { url_class: "UNKNOWN", is_obviously_invalid: false, reason: "workday URL needs GPT verification" };
}

/** True when the string cannot be parsed as an absolute http(s) URL. */
export function isMalformedJobUrl(url: string | null | undefined): boolean {
  const raw = (url || "").trim();
  if (!raw) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
}

/**
 * Classify a job URL for discovery admission.
 * DIRECT_POSTING = deterministic posting page.
 * INVALID classes (is_obviously_invalid) = must not QUALIFY.
 * UNKNOWN = GPT must verify (never invent).
 */
export function classifyPostingUrl(url: string | null | undefined): PostingUrlClassification {
  const raw = (url || "").trim();
  if (!raw) {
    return { url_class: "UNKNOWN", is_obviously_invalid: true, reason: "empty url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url_class: "UNKNOWN", is_obviously_invalid: false, reason: "unparseable url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url_class: "UNKNOWN", is_obviously_invalid: false, reason: "non-http url" };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || "/";
  const segments = pathSegments(pathname);

  if (isRecognizedAtsHost(host)) {
    return classifyRecognizedAts(host, pathname, segments, parsed);
  }

  if (isSearchPath(segments)) {
    return {
      url_class: "SEARCH_OR_LISTING",
      is_obviously_invalid: true,
      reason: "search or listing path",
    };
  }

  if (isCategoryPath(segments)) {
    return {
      url_class: "CATEGORY",
      is_obviously_invalid: true,
      reason: "category or department listing",
    };
  }

  if (isBareCareersHome(segments)) {
    return { url_class: "CAREERS_HOME", is_obviously_invalid: true, reason: "careers homepage" };
  }

  if (isBareJobsLanding(segments)) {
    if (hasJobIdQuery(parsed)) {
      return {
        url_class: "DIRECT_POSTING",
        is_obviously_invalid: false,
        reason: "query-based job id on jobs path",
      };
    }
    if (hasSearchQuery(parsed)) {
      return {
        url_class: "SEARCH_OR_LISTING",
        is_obviously_invalid: true,
        reason: "search or listing query on jobs path",
      };
    }
    return {
      url_class: "JOBS_LANDING",
      is_obviously_invalid: true,
      reason: "jobs/careers landing page",
    };
  }

  if (
    hasJobIdQuery(parsed) &&
    segments.some((segment) =>
      ["jobs", "job", "careers", "career", "positions", "position", "apply"].includes(segment),
    )
  ) {
    return { url_class: "DIRECT_POSTING", is_obviously_invalid: false, reason: "query-based job id" };
  }

  const postingMarkers = ["jobs", "job", "careers", "career", "positions", "position", "openings"];
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (postingMarkers.includes(segments[i])) {
      const id = segments[i + 1];
      if (
        id &&
        id.length >= 4 &&
        !["search", "all", "list", "departments", "teams", "home", "index"].includes(id)
      ) {
        return {
          url_class: "DIRECT_POSTING",
          is_obviously_invalid: false,
          reason: "path posting identifier",
        };
      }
    }
  }

  if (/\/jobs\/view\/\d+/i.test(pathname) || /[?&]jk=[a-z0-9]+/i.test(parsed.search)) {
    return {
      url_class: "DIRECT_POSTING",
      is_obviously_invalid: false,
      reason: "external job board posting id",
    };
  }

  return { url_class: "UNKNOWN", is_obviously_invalid: false, reason: "requires GPT verification" };
}

export function isDeterministicallyInvalidPostingUrl(url: string | null | undefined): boolean {
  return classifyPostingUrl(url).is_obviously_invalid;
}
