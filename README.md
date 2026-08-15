# Job Search Memory + Secured Remote MCP

Personal job-search pipeline with a clear responsibility split:

- **Python job agent** — normalize, duplicate-detect, score, filter, decide whether to persist
- **Remote Jay Job MCP** — authenticated storage/retrieval only (Neon PostgreSQL)
- **Local SQLite FastMCP** — retained as a development / legacy fallback

## Architecture

### Production path (recommended)

```
Job Sites
    ↓
ChatGPT job discovery
    ↓
Python job agent
    ├─ normalize
    ├─ detect duplicates
    ├─ score / filter
    └─ decide whether to persist
    ↓
Auth0 Client Credentials (M2M)
    ↓
Remote Jay Job MCP (/api/mcp)
    ↓
Neon PostgreSQL
```

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
| Normalization | Python job agent |
| Duplicate detection | Python job agent |
| Scoring / ranking / fit | Python job agent |
| Persist-or-not decision | Python job agent |
| AuthN / AuthZ for storage API | Auth0 + remote MCP |
| Job CRUD persistence | Remote MCP → Neon |
| Application decisions | Python / human — **not** MCP |

The remote MCP **must not** score jobs, rank jobs, decide candidate fit, perform duplicate decisions, or decide whether a discovered job should be saved.

## Repository structure

```
job_agent/                 # Python orchestration, scoring, duplicates
  integrations/            # Auth0 token provider + remote MCP client
  memory/                  # MemoryStore + duplicate detector
  ranking/                 # Scoring
  workflow/                # End-to-end pipeline
job_memory/                # Local SQLite FastMCP (dev/legacy)
remote_mcp/                # Vercel Next.js MCP (production persistence)
  migrations/              # Neon SQL migrations
  src/app/api/mcp          # via /api/[transport]
  src/app/api/health
  src/app/.well-known/oauth-protected-resource
mcp_server.py              # Local FastMCP entrypoint
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
```

Never commit real secrets. See `.env.example` and `remote_mcp/.env.example`.

## Neon

Schema migration:

`remote_mcp/migrations/001_initial.sql`

Apply once against Neon (SQL editor or `psql`). It uses `IF NOT EXISTS` / safe `ADD COLUMN IF NOT EXISTS` and does **not** destroy existing data. There is **no** `UNIQUE(url)` constraint — duplicate policy stays in Python.

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

## MCP tools

1. `save_job` — required: `company`, `title`, `url`
2. `get_job` — `id`
3. `search_jobs` — `query`, `limit`
4. `list_recent_jobs` — `days`, `limit`
5. `delete_job` — `id`

Public health endpoint (no auth): `GET /api/health`

## Persistence smoke test

With a valid Auth0 token that has all three scopes:

```
save_job → get_job → search_jobs → list_recent_jobs → delete_job
```

## Security model

- Cryptographic JWT verification with Auth0 JWKS (`jose`) — signature, issuer, audience, expiration, nbf
- Per-tool permission enforcement (`jobs:read|write|delete`)
- Parameterized SQL via Neon tagged templates
- Zod validation on MCP inputs
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
4. Apply `remote_mcp/migrations/001_initial.sql` if the live table needs the new columns
