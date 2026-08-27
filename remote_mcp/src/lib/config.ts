export const SERVICE_NAME = "jay-job-mcp";
export const SERVICE_VERSION = "0.1.0";

export const SCOPES = {
  READ: "jobs:read",
  WRITE: "jobs:write",
  DELETE: "jobs:delete",
  /** Dedicated ChatGPT / operator permission for audited batch revert only. */
  REVERT: "jobs:revert",
  /**
   * Worker-only scope for inbox claim/complete/fail, atomic persistence+provenance,
   * and fail-closed stale recovery. Must NOT be granted to the ChatGPT connector.
   */
  WORKER: "jobs:worker",
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
  find_canonical_jobs_by_company: SCOPES.READ,
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
  check_discovery_candidates: SCOPES.READ,
  compute_discovery_description_hashes: SCOPES.READ,
  record_discovery_evaluations: SCOPES.WRITE,
  record_application: SCOPES.WRITE,
  get_application: SCOPES.READ,
  list_applications: SCOPES.READ,
  update_application_status: SCOPES.WRITE,
  add_application_event: SCOPES.WRITE,
  list_application_events: SCOPES.READ,
  save_discovery_run: SCOPES.WRITE,
  list_discovery_runs: SCOPES.READ,
  // Candidate evaluations (Python scores; MCP stores only)
  save_job_evaluation: SCOPES.WRITE,
  get_latest_job_evaluation: SCOPES.READ,
  list_job_evaluations: SCOPES.READ,
  // Raw ChatGPT discovery inbox — user-facing submit/status only
  submit_discovery_batch: SCOPES.WRITE,
  get_discovery_batch: SCOPES.READ,
  list_pending_discovery_batches: SCOPES.READ,
  // Worker-only inbox operations (GitHub Actions M2M with jobs:worker)
  claim_discovery_batch: SCOPES.WORKER,
  complete_discovery_batch: SCOPES.WORKER,
  fail_discovery_batch: SCOPES.WORKER,
  apply_discovery_batch_job_persistence: SCOPES.WORKER,
  recover_stale_discovery_batch_claims: SCOPES.WORKER,
  // Discovery source rotation / checkpoint (no crawl / score / job persistence)
  get_discovery_rotation: SCOPES.READ,
  claim_next_discovery_source: SCOPES.WRITE,
  complete_discovery_source: SCOPES.WRITE,
  fail_discovery_source: SCOPES.WRITE,
  // Automatic discovery company registry / producer control plane
  list_discovery_companies: SCOPES.READ,
  upsert_discovery_company: SCOPES.WRITE,
  claim_due_discovery_companies: SCOPES.WORKER,
  complete_discovery_company_run: SCOPES.WORKER,
  fail_discovery_company_run: SCOPES.WORKER,
  start_automatic_discovery_run: SCOPES.WORKER,
  finish_automatic_discovery_run: SCOPES.WORKER,
  get_automatic_discovery_status: SCOPES.READ,
  get_storage_observability: SCOPES.READ,
  preview_description_retention: SCOPES.READ,
  preserve_pending_discovery_evaluations: SCOPES.WORKER,
  claim_pending_discovery_evaluations: SCOPES.WORKER,
  complete_pending_discovery_evaluation: SCOPES.WORKER,
  // Audited batch revert (ChatGPT / operators — dedicated scope)
  preview_discovery_batch_revert: SCOPES.READ,
  revert_discovery_batch: SCOPES.REVERT,
};

/** Tools ChatGPT connectors should never be granted (worker / delete scopes). */
export const CHATGPT_FORBIDDEN_SCOPES: JobScope[] = [
  SCOPES.WORKER,
  SCOPES.DELETE,
];

/** Recommended ChatGPT connector scopes after Milestone 4. */
export const CHATGPT_RECOMMENDED_SCOPES: JobScope[] = [
  SCOPES.READ,
  SCOPES.WRITE,
  SCOPES.REVERT,
];

/** Recommended GitHub Actions / Python worker M2M scopes. */
export const WORKER_RECOMMENDED_SCOPES: JobScope[] = [
  SCOPES.READ,
  SCOPES.WRITE,
  SCOPES.WORKER,
];

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
