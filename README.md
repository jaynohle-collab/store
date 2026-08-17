# Job Search Memory + Secured Remote MCP

Personal job-search pipeline with a clear responsibility split:

- **Python job agent** — normalize, duplicate-detect, score, filter, decide whether to persist
- **Remote Jay Job MCP** — authenticated storage/retrieval only (Neon PostgreSQL)
- **Local SQLite FastMCP** — retained as a development / legacy fallback

## Architecture

### Production path (recommended)

```
OpenAI job discovery (Responses API + web_search)
      ↓
raw discovery JSON  { "jobs": [ ... ] }
      ↓
Python Job Agent
    ├─ normalize
    ├─ SAME_POSTING / REPOST / NEW_JOB (lifecycle)
    ├─ profile-v1 candidate scoring
    └─ evaluation + persist decisions
      ↓
Auth0 Client Credentials (M2M)
      ↓
Remote Jay Job MCP (/api/mcp)
      ↓
Neon PostgreSQL
      ↓
Dashboard
```

Discovery **only** finds current jobs and extracts raw fields. It must **not** score candidates, decide duplicates/reposts, or write to Neon/MCP. The Python agent remains the sole owner of normalization, lifecycle classification, scoring, evaluation persistence, and MCP persistence.

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
| Current job discovery (web search) | OpenAI discovery runner |
| Normalization | Python job agent |
| Duplicate / SAME_POSTING / REPOST / NEW_JOB | Python job agent |
| Scoring / ranking / fit (`profile-v1`) | Python job agent |
| Persist-or-not decision | Python job agent |
| AuthN / AuthZ for storage API | Auth0 + remote MCP |
| Job CRUD persistence | Remote MCP → Neon |
| Application decisions | Python / human — **not** MCP |

Discovery and the remote MCP **must not** score jobs, rank jobs, decide candidate fit, perform duplicate/repost decisions, or decide whether a discovered job should be saved.

## Repository structure

```
job_agent/                 # Python orchestration, scoring, duplicates
  discovery/               # OpenAI Responses API discovery (raw JSON only)
  integrations/            # Auth0 token provider + remote MCP client
  memory/                  # MemoryStore + duplicate detector
  ranking/                 # Scoring (profile-v1)
  workflow/                # End-to-end pipeline
  examples/
    daily_job_run.py       # Ingest file → existing pipeline
    automated_daily_run.py # Discover → existing pipeline
job_memory/                # Local SQLite FastMCP (dev/legacy)
remote_mcp/                # Vercel Next.js MCP (production persistence)
  migrations/              # Neon SQL migrations
  src/app/api/mcp          # via /api/[transport]
  src/app/api/health
  src/app/.well-known/oauth-protected-resource
mcp_server.py              # Local FastMCP entrypoint
.github/workflows/
  ci.yml
  daily-job-discovery.yml  # schedule + workflow_dispatch
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

## Automated daily discovery

Unattended discovery uses the official OpenAI Python SDK **Responses API** with the built-in `web_search` tool and strict JSON Schema structured outputs. The runner then hands raw `{ "jobs": [...] }` to the existing `run_daily_job_run` pipeline (`JOB_PERSISTENCE_MODE=remote`).

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

- **`workflow_dispatch`** — manual production testing from the Actions tab
- **`schedule`** — daily cron `0 15 * * *` (≈ 8:00 AM Pacific during PDT; GitHub cron is UTC, so DST can shift the effective local hour to ~7:00 AM PST)

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
| `JOB_PERSISTENCE_MODE` | `remote` |
| `JOB_MCP_URL` | `https://jay-job-mcp.vercel.app/api/mcp` |
| `AUTH0_TOKEN_URL` | `https://jay-job.us.auth0.com/oauth/token` |
| `AUTH0_AUDIENCE` | existing API audience `https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp` |
| `AUTH0_SCOPES` | `jobs:read jobs:write jobs:delete` |

`AUTH0_AUDIENCE` intentionally preserves the currently configured Auth0 API audience and is **not** rewritten to the public stable MCP hostname.

#### workflow_dispatch testing

1. Open **Actions → Daily Job Discovery**
2. Click **Run workflow**
3. Inspect the job log for discovery counts and persistence summary
4. Confirm dashboard / Neon received expected postings

#### Disable the schedule

- Disable the workflow in the GitHub Actions UI, or
- Remove / comment the `schedule:` block in `daily-job-discovery.yml`, or
- Temporarily rename/remove the workflow file on a branch (do not leave secrets in YAML)

#### Inspect failures

GitHub → **Actions** → select the failed **Daily Job Discovery** run → open the `discover-and-persist` job log. Secrets are never printed by the runner.

## Neon

Schema migrations:

1. `remote_mcp/migrations/001_initial.sql` — canonical schema for new environments
2. `remote_mcp/migrations/002_neon_poc_compatibility.sql` — safe additive migration for the already-deployed Neon PoC

   - Detects existing `jobs.id` type
   - If UUID: preserves values; backfills NULLs only
   - If TEXT/VARCHAR: validates every non-null value is a UUID string, then converts with `USING btrim(id::text)::uuid`
   - If any non-null id is invalid: **aborts** and leaves data unmodified
   - Also repairs timestamps → TIMESTAMPTZ and skills → JSONB when safely convertible
   - Fixtures/docs: `remote_mcp/migrations/fixtures/`

Apply against Neon (SQL editor or `psql`). Both use `IF NOT EXISTS` / safe `ADD COLUMN IF NOT EXISTS` and do **not** destroy existing data. There is **no** `UNIQUE(url)` constraint — duplicate policy stays in Python.

`description_hash` is persisted and returned so the Python agent can keep fingerprint-based duplicate detection. `search_jobs` and `list_recent_jobs` support `offset` / `next_offset` pagination so remote history is not capped at 100 rows.

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

### Automated discovery + remote persistence

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

`save_job` also accepts optional `description_hash` and validates `posted_date` as an ISO date or offset datetime.

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
