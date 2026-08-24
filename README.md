# Job Search Memory + Secured Remote MCP

Personal job-search pipeline with a clear responsibility split:

- **Python job agent** — normalize, duplicate-detect, score, filter, decide whether to persist
- **Remote Jay Job MCP** — authenticated storage/retrieval only (Neon PostgreSQL)
- **Local SQLite FastMCP** — retained as a development / legacy fallback

## Architecture

### Production path (recommended)

```
ChatGPT
   ↓
web job discovery (lightweight candidates)
   ↓
check_discovery_candidates (MCP read-only preflight)
   ↓
full description fetch + GPT admission scoring (gpt-fit-v1)
   ↓
record_discovery_evaluations (MCP — qualified + rejected)
   ↓
submit_discovery_batch (QUALIFIED jobs only, optional gpt_evaluation)
   ↓
raw discovery inbox (Neon)
   ↓
python -m job_agent.examples.process_discovery_inbox
   ↓
Python Job Agent
    ├─ normalize
    ├─ SAME_POSTING / REPOST / NEW_JOB (lifecycle)
    ├─ profile-v1 ranking score (dashboard; separate from GPT admission)
    └─ evaluation + persist decisions
   ↓
existing MCP persistence
   ↓
Neon / Dashboard
```

### GPT admission vs Python ranking

| Score | Owner | Purpose | Storage |
|---|---|---|---|
| GPT admission (`gpt-fit-v1`) | ChatGPT | Gate which jobs enter the discovery inbox | `discovery_gpt_evaluations` via `record_discovery_evaluations` |
| Python ranking (`profile-v1`) | Python job agent | Dashboard ranking / match display | `job_evaluations` via `save_job_evaluation` |

These scores must stay separate. MCP never computes either score; it stores GPT admission evidence and Python ranking snapshots.

### Required ChatGPT discovery workflow

1. **Preflight** — `check_discovery_candidates` with lightweight candidates (no scores/decisions/reasoning in candidate objects). Optional top-level `evaluation_version` (default `gpt-fit-v1`).
2. **Full description evaluation** — for candidates that need GPT reevaluation, fetch full descriptions and apply the `gpt-fit-v1` rubric (threshold 70; hard exclusions → `REJECTED_HARD_RULE`).
3. **Record all evaluations** — `record_discovery_evaluations` for both QUALIFIED and rejected decisions (idempotent by `client_evaluation_id`; does not create canonical jobs or inbox rows).
4. **Submit qualified jobs only** — `submit_discovery_batch` with QUALIFIED jobs only. Nested `gpt_evaluation` must include `evaluation_id` referencing stored evidence (`gpt_decision=QUALIFIED`, `gpt_relevance_score >= 70`). When `DISCOVERY_REQUIRE_GPT_EVALUATION=true` (required in production after verification), every job must include matching stored evidence.

Hard exclusions (GPT): closed/expired/archived; internship/junior; frontend-only; pure DevOps/SRE without meaningful AI/backend ownership; non-US; NYC onsite-only; no direct job URL.

ChatGPT **must not** decide duplicates/reposts, create canonical jobs, or write Python `profile-v1` evaluations. MCP remains read-only for preflight identity lookup and stores GPT admission evidence without mutating applications or canonical jobs.

User prompt:

> Find today's matching jobs, preflight them, evaluate relevance, record evaluations, and submit only qualified jobs.

Then process the inbox:

```bash
python -m job_agent.examples.process_discovery_inbox
```

Optional flags: `--limit 10` (default 10), `--batch-id <uuid>`.

Zero pending batches is a successful no-op.

### ChatGPT direct MCP access

```
ChatGPT
    ↓
Auth0 OAuth (authorization code / user login)
    ↓
Remote Jay Job MCP (/api/mcp)
    ↓
Neon PostgreSQL
```

Production MCP URL:

`https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp`

## Responsibility boundaries

| Concern | Owner |
|---|---|
| Current job discovery (web search) | ChatGPT |
| Identity preflight (`check_discovery_candidates`) | Remote MCP (read-only) |
| GPT admission scoring (`gpt-fit-v1`) | ChatGPT |
| GPT evaluation evidence storage | Remote MCP → Neon (`discovery_gpt_evaluations`) |
| Raw inbox submit/claim/complete/fail | Remote MCP → Neon (`discovery_inbox_batches`) |
| Normalization | Python job agent |
| Duplicate / SAME_POSTING / REPOST / NEW_JOB | Python job agent |
| Dashboard ranking / fit (`profile-v1`) | Python job agent |
| Persist-or-not decision (post-inbox) | Python job agent |
| AuthN / AuthZ for storage API | Auth0 + remote MCP |
| Job CRUD persistence | Remote MCP → Neon |
| Application decisions | Python / human — **not** MCP |

ChatGPT owns GPT admission scoring (`gpt-fit-v1`) before inbox submit. MCP stores that evidence and performs identity lookup only. MCP and ChatGPT **must not** perform duplicate/repost decisions, create canonical jobs from discovery evaluations, or overwrite Python `profile-v1` ranking scores.

## Repository structure

```
job_agent/                 # Python orchestration, scoring, duplicates
  discovery/               # Raw discovery validation + inbox processor helpers
  integrations/            # Auth0 token provider + remote MCP client
  memory/                  # MemoryStore + duplicate detector
  ranking/                 # Scoring (profile-v1)
  workflow/                # End-to-end pipeline
  examples/
    daily_job_run.py              # Ingest file/payload → existing pipeline
    process_discovery_inbox.py    # Claim inbox batches → daily_job_run
    automated_daily_run.py        # Legacy OpenAI API discovery (optional)
job_memory/                # Local SQLite FastMCP (dev/legacy)
remote_mcp/                # Vercel Next.js MCP (production persistence)
  migrations/              # Neon SQL migrations (005_discovery_inbox.sql)
  src/app/api/mcp          # via /api/[transport]
  src/app/api/health
  src/app/.well-known/oauth-protected-resource
mcp_server.py              # Local FastMCP entrypoint
.github/workflows/
  ci.yml
  daily-job-discovery.yml  # legacy OpenAI schedule (disabled unless enabled)
```

## Persistence modes

| Mode | Env | Backend | Use |
|---|---|---|---|
| **remote** (production) | `JOB_PERSISTENCE_MODE=remote` | Auth0 + Vercel MCP + Neon | Production |
| **local** (default) | `JOB_PERSISTENCE_MODE=local` | SQLite FastMCP (`job_memory`) | Dev / tests / legacy |

Local SQLite is intentionally preserved. Do not delete it until remote MCP is fully validated in your workflows.

## Auth0 configuration

Already expected to exist (do not auto-create):

- **API**: Jay Job MCP API
- **Audience**: `https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp`
- **Permissions / scopes**:
  - `jobs:read`
  - `jobs:write`
  - `jobs:delete`
- **RBAC** + **Add Permissions in the Access Token** enabled
- **M2M app**: Jay Job Python Agent (all three permissions)

### Scope → tool mapping

| Tool | Permission | Annotations |
|---|---|---|
| `get_job` | `jobs:read` | read-only |
| `search_jobs` | `jobs:read` | read-only |
| `list_recent_jobs` | `jobs:read` | read-only |
| `save_job` | `jobs:write` | write (not destructive) |
| `delete_job` | `jobs:delete` | destructive |
| `submit_discovery_batch` | `jobs:write` | raw inbox submit |
| `get_discovery_batch` | `jobs:read` | raw inbox get |
| `list_pending_discovery_batches` | `jobs:read` | raw inbox list |
| `claim_discovery_batch` | `jobs:write` | pending → processing |
| `complete_discovery_batch` | `jobs:write` | processing → completed |
| `fail_discovery_batch` | `jobs:write` | processing → failed |

HTTP semantics:

- **401** — missing / malformed / invalid / expired / wrong issuer / wrong audience
- **403** — valid JWT missing the permission required for the tool call

Unauthenticated MCP requests include a `WWW-Authenticate` Bearer challenge pointing at:

`/.well-known/oauth-protected-resource`

Auth0 remains the authorization server. This repo does **not** implement a custom OAuth server.

## Environment variables

### Vercel (`remote_mcp` / project `jay-job-mcp`)

```bash
DATABASE_URL=                 # Neon connection string (already configured in prod)
AUTH0_ISSUER=                 # e.g. https://YOUR_TENANT.us.auth0.com/
AUTH0_AUDIENCE=https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp
MCP_SERVER_URL=https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app
```

The MCP server validates JWTs via JWKS derived from `AUTH0_ISSUER`.
It does **not** need `AUTH0_CLIENT_SECRET`.

### Python job agent

```bash
JOB_PERSISTENCE_MODE=remote
JOB_MCP_URL=https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp
AUTH0_TOKEN_URL=https://YOUR_TENANT.us.auth0.com/oauth/token
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
AUTH0_AUDIENCE=https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1
# DISCOVERY_MAX_JOBS=100
```

Never commit real secrets. See `.env.example` and `remote_mcp/.env.example`.

## Automated daily discovery (legacy OpenAI API)

The ChatGPT inbox path above is the recommended workflow. The OpenAI Responses API runner remains in the repo but is not required.

Unattended OpenAI discovery uses the official OpenAI Python SDK **Responses API** with the built-in `web_search` tool and strict JSON Schema structured outputs. The runner then hands raw `{ "jobs": [...] }` to the existing `run_daily_job_run` pipeline (`JOB_PERSISTENCE_MODE=remote`).

Discovery does **not** score, dedupe, classify reposts, or write to Neon/MCP.

### Local manual invocation

```bash
# activate venv, install deps
pip install -r requirements.txt

# set OPENAI_* + Auth0 + JOB_* env vars (see .env.example)
python -m job_agent.examples.automated_daily_run
```

Or ingest an already-produced JSON file (UTF-8 with or without BOM):

```bash
python -m job_agent.examples.daily_job_run
```

### GitHub Actions

Workflow: `.github/workflows/daily-job-discovery.yml`

Supports:

- **`workflow_dispatch`** — manual production testing from the Actions tab (**always allowed**)
- **`schedule`** — daily cron `0 15 * * *` (≈ 8:00 AM Pacific during PDT; GitHub cron is UTC, so DST can shift the effective local hour to ~7:00 AM PST)

Scheduled runs are gated by repository variable **`JOB_DISCOVERY_SCHEDULE_ENABLED`**.
If the variable is absent or not exactly `true`, schedule events skip the job safely.
`workflow_dispatch` is never gated by that variable.

#### Safe rollout

1. Merge the discovery code
2. Configure secrets / variables (`OPENAI_API_KEY`, Auth0 M2M, `OPENAI_MODEL`, …)
3. Leave `JOB_DISCOVERY_SCHEDULE_ENABLED` **unset** or `false`
4. Run **workflow_dispatch** manually
5. Verify dashboard / Neon
6. Set `JOB_DISCOVERY_SCHEDULE_ENABLED=true`
7. Daily cron becomes active

#### Pause the schedule

Set `JOB_DISCOVERY_SCHEDULE_ENABLED=false` (or delete the variable).
Manual `workflow_dispatch` continues to work.

#### Required GitHub secrets

| Secret | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API access |
| `AUTH0_CLIENT_ID` | M2M client id |
| `AUTH0_CLIENT_SECRET` | M2M client secret |

#### Required / configured non-secret values

| Name | Value |
|---|---|
| `OPENAI_MODEL` | GitHub Actions variable (default `gpt-4.1` in workflow) |
| `JOB_DISCOVERY_SCHEDULE_ENABLED` | repository variable; must be `true` for cron (leave unset/false until verified) |
| `DISCOVERY_TIME_ZONE` | optional; default `America/Los_Angeles` |
| `JOB_PERSISTENCE_MODE` | `remote` |
| `JOB_MCP_URL` | `https://jay-job-mcp.vercel.app/api/mcp` |
| `AUTH0_TOKEN_URL` | `https://jay-job.us.auth0.com/oauth/token` |
| `AUTH0_AUDIENCE` | existing API audience `https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp` |
| `AUTH0_SCOPES` | `jobs:read jobs:write jobs:delete` |

`AUTH0_AUDIENCE` intentionally preserves the currently configured Auth0 API audience and is **not** rewritten to the public stable MCP hostname.

Discovery freshness uses the current calendar date in `DISCOVERY_TIME_ZONE` (default `America/Los_Angeles`) and injects it into the prompt at request time.

#### workflow_dispatch testing

1. Open **Actions → Daily Job Discovery**
2. Click **Run workflow**
3. Inspect the job log for discovery counts and persistence summary
4. Confirm dashboard / Neon received expected postings

#### Disable / pause the schedule

- Set `JOB_DISCOVERY_SCHEDULE_ENABLED=false`, or
- Disable the workflow in the GitHub Actions UI, or
- Remove / comment the `schedule:` block in `daily-job-discovery.yml`

#### Inspect failures

GitHub → **Actions** → select the failed **Daily Job Discovery** run → open the `discover-and-persist` job log. Secrets are never printed by the runner.

## Neon

Schema migrations:

1. `remote_mcp/migrations/001_initial.sql` — canonical schema for new environments
2. `remote_mcp/migrations/002_neon_poc_compatibility.sql` — safe additive migration for the already-deployed Neon PoC
3. `remote_mcp/migrations/003_job_lifecycle.sql` — canonical jobs / postings / applications / `discovery_runs`
4. `remote_mcp/migrations/004_job_evaluations.sql` — Python evaluation snapshots
5. `remote_mcp/migrations/005_discovery_inbox.sql` — raw ChatGPT inbox (`discovery_inbox_batches`; does **not** replace `discovery_runs`)
6. `remote_mcp/migrations/006_discovery_source_rotation.sql` — ordered discovery source rotation / checkpoints
7. `remote_mcp/migrations/007_discovery_gpt_evaluations.sql` — GPT admission evaluations (`discovery_gpt_evaluations`; separate from Python `job_evaluations`)

   - Detects existing `jobs.id` type
   - If UUID: preserves values; backfills NULLs only
   - If TEXT/VARCHAR: validates every non-null value is a UUID string, then converts with `USING btrim(id::text)::uuid`
   - If any non-null id is invalid: **aborts** and leaves data unmodified
   - Also repairs timestamps → TIMESTAMPTZ and skills → JSONB when safely convertible
   - Fixtures/docs: `remote_mcp/migrations/fixtures/`

Apply against Neon (SQL editor or `psql`). Both use `IF NOT EXISTS` / safe `ADD COLUMN IF NOT EXISTS` and do **not** destroy existing data. There is **no** `UNIQUE(url)` constraint — duplicate policy stays in Python.

`description_hash` is persisted and returned so the Python agent can keep fingerprint-based duplicate detection. Canonical format (Python `compute_description_hash` / GPT evaluation validation): **16 lowercase hexadecimal characters** (`sha256(normalized)[:16]`), or empty when unavailable. `search_jobs` and `list_recent_jobs` support `offset` / `next_offset` pagination so remote history is not capped at 100 rows.

Useful indexes: `url`, `company`, `title`, `posted_date`, `created_at`.

## Vercel deployment

Existing project: **jay-job-mcp**

Manual steps:

1. Set **Root Directory** to `remote_mcp`
2. Framework preset: Next.js
3. Confirm env vars above (especially `AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `MCP_SERVER_URL`, `DATABASE_URL`)
4. Deploy from branch `feature/secure-remote-mcp` (or merge when ready)
5. Keep production URL: `https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp`

## Local development

### Remote MCP (Next.js)

```bash
cd remote_mcp
cp .env.example .env.local   # fill placeholders
npm install
npm run dev
# health: http://localhost:3000/api/health
# mcp:    http://localhost:3000/api/mcp
```

### Local SQLite FastMCP (legacy)

```bash
python -m venv .venv
# activate venv
pip install -r requirements.txt
python run_server.py
```

### Python agent against remote MCP

```bash
# set JOB_PERSISTENCE_MODE=remote and Auth0 env vars
python -m job_agent.examples.daily_job_run
```

### Process ChatGPT discovery inbox

```bash
# set JOB_PERSISTENCE_MODE=remote and Auth0 env vars
python -m job_agent.examples.process_discovery_inbox
python -m job_agent.examples.process_discovery_inbox --limit 10
python -m job_agent.examples.process_discovery_inbox --batch-id <uuid>
```

A failed Python workflow marks the batch `failed`, keeps the raw payload, and stores a concise error. Batches are never deleted by the processor.

### Legacy OpenAI API discovery (optional)

```bash
# set OPENAI_API_KEY, OPENAI_MODEL, Auth0, and JOB_* env vars
python -m job_agent.examples.automated_daily_run
```

## MCP tools

1. `save_job` — required: `company`, `title`, `url`
2. `get_job` — `id`
3. `search_jobs` — `query`, `limit`
4. `list_recent_jobs` — `days`, `limit`, `offset`
5. `delete_job` — `id`

6. `submit_discovery_batch` — ChatGPT jobs (`jobs`, `source`, `metadata`). Nested `gpt_evaluation` (when present) must include `evaluation_id`, `gpt_relevance_score`, `gpt_decision=QUALIFIED`, `evaluation_version`, and optional `reasoning_summary`, and must match a stored QUALIFIED evaluation (score >= 70, matching identity/version/hash). When `DISCOVERY_REQUIRE_GPT_EVALUATION=true`, every job must include that attachment. Default of the flag is `false` for rollout; production must set it to `true` after deployment verification. Rejected jobs are not accepted into the inbox.
7. `get_discovery_batch` — `id`
8. `list_pending_discovery_batches` — `limit`
9. `claim_discovery_batch` — optional `id`; pending → processing
10. `complete_discovery_batch` — `id`; processing → completed
11. `fail_discovery_batch` — `id`, `error`; processing → failed (payload retained)

12. `check_discovery_candidates` — read-only batch identity preflight (1–100 lightweight candidates). Optional top-level `evaluation_version` (default `gpt-fit-v1`). Candidate objects must not include scores, decisions, or reasoning. Returns identity status plus `prior_gpt_evaluation` / `gpt_reevaluation_required` / `gpt_skip_allowed` / `gpt_reuse_allowed` for deterministic URL or source+external_id matches only. Matching rejected priors may be skipped; matching qualified priors may be reused via `evaluation_id`. Does not score, save, claim, or mutate.
13. `record_discovery_evaluations` — write 1–100 GPT admission evaluations (`jobs:write`). Requires `client_evaluation_id` (UUID). Idempotent: identical payload retries return the existing record; conflicting payloads for the same ID are rejected. Latest lookups use server `created_at` + `id` (never client `evaluated_at`). Does not create canonical jobs, submit inbox batches, or change application status.

14. `get_discovery_rotation` — read-only; ordered enabled sources, current cursor, cycle ID, latest run status.
15. `claim_next_discovery_source` — atomically claim the current source (`run_id`, `cycle_id`, source, `attempt_number`, checkpoint). Blocks concurrent active claims. Stale claims consume one attempt: below max they are `failed` and the same source is reclaimed; at `DISCOVERY_SOURCE_MAX_ATTEMPTS` the stale run becomes `skipped_after_failures` and the next enabled source is claimed in the same call (`stale_source_skipped`, `stale_source_key`, `recovered_stale_run_id`).
16. `complete_discovery_source` — `run_id`, counters, optional `checkpoint`; marks completed and advances to the next enabled source (wraps to a new cycle at ashby after the last). Advances even when `qualified_count` is 0 and resets that source's failure count.
17. `fail_discovery_source` — `run_id`, `error`, optional `checkpoint`; records a sanitized error. Below `DISCOVERY_SOURCE_MAX_ATTEMPTS` (default 3) the cursor stays on the same source (`retry_required: true`). At the limit the run is `skipped_after_failures`, the cursor auto-advances (`auto_advanced: true`), and returns `next_source_key` / `next_cycle_id`. Skipped runs are not successful zero-result completions.

Rotation tools do not crawl, call GPT, score, or persist jobs. Counter chain validated: `submitted_count <= qualified_count <= evaluated_count <= discovered_count`, `preflight_skipped_count <= discovered_count`. Checkpoint size capped by `DISCOVERY_SOURCE_CHECKPOINT_MAX_BYTES` (default 64 KiB). Initial source order: ashby → greenhouse → lever → workday → company_careers.

`save_job` also accepts optional `description_hash` and validates `posted_date` as an ISO date or offset datetime.

Inbox `remote_status` is `""` / `Remote` / `Hybrid` / `Onsite`. `posted_date` is `""` or `YYYY-MM-DD`. Max batch size is `DISCOVERY_MAX_JOBS` (default 100).

Public health endpoint (no auth): `GET /api/health`

## Persistence smoke test

With a valid Auth0 token that has all three scopes:

```
save_job → get_job → search_jobs → list_recent_jobs → delete_job
```

## Security model

- Cryptographic JWT verification with Auth0 JWKS (`jose`) — signature, issuer, audience, expiration, nbf
- Per-tool permission enforcement (`jobs:read|write|delete`) for both modern `Mcp-Method` / `Mcp-Name` headers and legacy JSON-RPC bodies
- Parameterized SQL via Neon tagged templates
- Zod 4 validation on MCP inputs
- Official MCP Python SDK for the remote client transport
- No client secrets on the MCP server
- Tokens / client secrets are redacted from Python logs
- Health endpoint never returns connection strings or secrets

## Tests

```bash
# remote MCP
cd remote_mcp && npm test

# Python Auth0 client + existing agent tests
python -m unittest discover -s job_agent/tests -v
```

## Manual values you must supply

1. Auth0 tenant issuer (`AUTH0_ISSUER` / `AUTH0_TOKEN_URL`)
2. M2M Client ID + Client Secret (Python only)
3. Confirm Neon `DATABASE_URL` on Vercel
4. Apply `remote_mcp/migrations/001_initial.sql` and, for the existing Neon PoC, `002_neon_poc_compatibility.sql`
