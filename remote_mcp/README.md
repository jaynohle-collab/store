# Jay Job MCP (remote_mcp)

Vercel-deployable Next.js MCP persistence service.

See the repository root [README.md](../README.md) for architecture, Auth0, Neon, and deployment docs.

## Scripts

```bash
npm install
npm run dev
npm test
npm run build
```

## Endpoints

- `GET /api/health` — public health
- `POST /api/mcp` — authenticated Streamable HTTP MCP
- `GET /.well-known/oauth-protected-resource` — OAuth protected-resource metadata

### Haiku attempt controls (disabled pending review)

Migration `017_haiku_attempt_budget.sql` adds worker-only `reserve_haiku_attempt`
(`request_sha256`) and `claim_haiku_attempt` (`reservation_id`, `request_sha256`).
Both require `jobs:worker` and a verified subject/client identity. Do not grant
this scope to ChatGPT connectors. The digest is SHA-256 of the exact UTF-8
Anthropic request body. The client must verify the claim policy, server time,
and dispatch deadline before a single HTTP attempt; retries reserve again.

The database clock chooses the America/Los_Angeles day/month. A shared row lock
serializes reservations, and both daily (50) and monthly counters update in one
transaction across all workers/identities. Each attempt reserves 5,000 microUSD
($0.005), including failed/expired attempts, with no refunds. The application
monthly allowance cannot exceed 30,000,000 microUSD ($30). The fixed policy is
`claude-haiku-5-5`, at most 16,000 bytes for the **entire encoded JSON
request**, at most 2,048 output tokens. This conservative application allowance
is not a verified invoice cap or a budget for other services/key consumers.

Migration alone does not enable inference. The server requires both
`HAIKU_BUDGET_CONTROLS_APPROVED=true` and a valid
`HAIKU_MONTHLY_LIMIT_MICRO_USD` between 5,000 and 30,000,000. Keep defaults false/0
until policy and pricing review. Claiming also checks this kill switch. Only the
backend DB role may access these invoker-security functions/tables; migration
revokes PUBLIC privileges. Review deployment-specific role grants separately.

Reservations expire within 60 seconds, claims are one-use and owner/digest-bound,
and dispatch must occur within five seconds. Reservations/claims are denied
within ten seconds of midnight. A lost response consumes budget without granting
a usable authorization. Clients fail closed on errors or uncertain outcomes.
Local PGlite tests exercise SQL atomicity and time boundaries. Independent local
PostgreSQL 18.6 tests also passed: 75 connections obtained exactly 50 daily grants,
monthly exhaustion respected the configured allowance, simultaneous claims
granted once, rollback preserved both counters, and lock-wait timing used the
database clock after release. See `../docs/haiku-evaluation.md` for details.
