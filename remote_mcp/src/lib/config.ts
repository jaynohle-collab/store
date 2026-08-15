export const SERVICE_NAME = "jay-job-mcp";
export const SERVICE_VERSION = "0.1.0";

export const SCOPES = {
  READ: "jobs:read",
  WRITE: "jobs:write",
  DELETE: "jobs:delete",
} as const;

export type JobScope = (typeof SCOPES)[keyof typeof SCOPES];

export const TOOL_PERMISSIONS: Record<string, JobScope> = {
  // Legacy PoC jobs table
  get_job: SCOPES.READ,
  search_jobs: SCOPES.READ,
  list_recent_jobs: SCOPES.READ,
  save_job: SCOPES.WRITE,
  delete_job: SCOPES.DELETE,
  // Lifecycle persistence (no scoring / repost classification)
  save_canonical_job: SCOPES.WRITE,
  get_canonical_job: SCOPES.READ,
  find_canonical_jobs: SCOPES.READ,
  touch_canonical_job: SCOPES.WRITE,
  save_job_posting: SCOPES.WRITE,
  update_job_posting: SCOPES.WRITE,
  get_job_posting: SCOPES.READ,
  search_job_postings: SCOPES.READ,
  list_recent_postings: SCOPES.READ,
  list_postings_for_canonical: SCOPES.READ,
  list_reposted_postings: SCOPES.READ,
  list_reposts_with_prior_applications: SCOPES.READ,
  find_posting_by_url: SCOPES.READ,
  find_posting_by_external_id: SCOPES.READ,
  record_application: SCOPES.WRITE,
  get_application: SCOPES.READ,
  list_applications: SCOPES.READ,
  update_application_status: SCOPES.WRITE,
  add_application_event: SCOPES.WRITE,
  list_application_events: SCOPES.READ,
  save_discovery_run: SCOPES.WRITE,
  list_discovery_runs: SCOPES.READ,
};

export function getAuth0Issuer(): string | undefined {
  const issuer = process.env.AUTH0_ISSUER?.trim();
  return issuer || undefined;
}

export function getAuth0Audience(): string | undefined {
  const audience = process.env.AUTH0_AUDIENCE?.trim();
  return audience || undefined;
}

export function getMcpServerUrl(): string | undefined {
  const url = process.env.MCP_SERVER_URL?.trim();
  return url ? url.replace(/\/$/, "") : undefined;
}

export function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url || undefined;
}

export function getJwksUrl(issuer = getAuth0Issuer()): string | undefined {
  const explicit = process.env.AUTH0_JWKS_URL?.trim();
  if (explicit) return explicit;
  if (!issuer) return undefined;
  return `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
}

export function isAuthConfigured(): boolean {
  return Boolean(getAuth0Issuer() && getAuth0Audience());
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getDatabaseUrl());
}

export function getProtectedResourceUrl(): string {
  const base = getMcpServerUrl();
  if (base) return `${base}/api/mcp`;
  const audience = getAuth0Audience();
  if (audience) return audience;
  return "http://localhost:3000/api/mcp";
}
