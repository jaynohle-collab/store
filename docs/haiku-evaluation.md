# Haiku evaluation integration

This implementation is disabled by default. Adding an Anthropic secret or
deploying the code does not authorize or activate paid usage.

## What is wired

- `ANTHROPIC_API_KEY` is read only by the Python worker. It is never put in the
  database, sent to MCP, or printed in workflow logs.
- The pinned model is `claude-haiku-5-5` (Haiku 5.5). Other models and
  aliases are rejected until their policy is reviewed and updated together.
- The manual **Haiku Job Discovery** workflow selects Anthropic explicitly.
  The existing scheduled workflow also passes the key and approval flag. Once
  approved, Haiku is preferred unless a custom provider order overrides it.
- One candidate is evaluated per request. The entire UTF-8 JSON request is
  limited to 16,000 bytes, output to 2,048 tokens. Haiku 5.5 uses low effort,
  disabled thinking, and no sampling parameters. Only answer text is parsed.
  Oversized inputs are deferred
  or tried on an already-configured free provider, never silently truncated.
- The Anthropic transport sends exactly one HTTP request. It does not follow
  redirects, use SDK auto-retries, discover replacement models, or refund an
  attempt after failure. A later retry must obtain a new reservation and claim.

## Durable guard

Migration 017 and authenticated worker-only MCP tools reserve capacity in one
database transaction. A singleton row lock serializes competing reservations.
The hard ceiling is **50 Haiku attempts per America/Los_Angeles calendar day**
across scheduled, manual, resumed and concurrent runs. This timezone remains a
proposed policy for approval, not an inferred permanent user preference.

Failed requests, invalid outputs, timeouts, expired reservations and lost replies
consume capacity. Cached evaluations and free-provider work do not. A daily
count is a maximum, not a promise of 50 successful or saved jobs.

Each reservation is bound to the authenticated subject/client identity and the
SHA-256 hash of the exact request body. A second atomic operation claims it once.
Claims expire within five seconds, and the client checks the fixed model, limits,
server time, policy version and deadline before dispatch. Missing auth, migration,
database access, malformed replies or clock skew all prevent paid dispatch.
Budget exhaustion uses the existing pending queue and provider-outage circuit;
it does not mark a job unqualified or discard it.

These are trusted-worker application controls. A person/service holding the raw
Anthropic key can bypass the application, so provider-account controls still
matter. This counts reservations on the database day, not provider billing-day
processing. Operating-system/network delays can cross a boundary after dispatch.

## Monthly cost review required

Every reservation conservatively consumes **5,000 microUSD ($0.005)** with no
refund. The configured Haiku application allowance is capped at **$30/month**,
but defaults to zero. A 31-day month permits at most 1,550 attempts under the
50/day policy, reserving $7.75 at this allowance. A smaller configured monthly
allowance may stop usage earlier.
It does not account for other services, unrelated API-key consumers, taxes or
changes to provider pricing. It therefore is not an invoice cap or a guarantee
of a $30 total Jay Job bill.

Official pricing checked November 11, 2026 lists Haiku 5.5 at $0.10 per million
input tokens and $0.50 per million output tokens for prompts up to 100,000 tokens.
Using 16,000 input tokens as a conservative proxy for the byte-bounded text and
2,048 output tokens gives $0.002624 per request. The $0.005 reservation is about
1.9 times that estimate. The payload has no tools, images, caching, batch mode,
or regional-inference options. UTF-8 bytes are not a provider-certified token
ceiling: tokenization and framing are not measured here, so this is a planning
estimate, not a hard provider billing cap. Validate representative counts and
actual usage before enabling, and recheck pricing if rollout is delayed.

Sources: [current model and pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide),
[supported effort settings](https://platform.claude.com/docs/en/build-with-claude/effort),
and [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).

Before enabling, confirm how much of the total
Jay Job monthly budget remains after other services and choose a Haiku allowance
within it. Confirm the proposed daily reset timezone. Review provider-side
spend limits, prepaid credit/auto-reload settings and any minimum charges.

## Rollout checklist

1. Review the code and migration. Independent real PostgreSQL contention and
   rollback tests passed locally (results below); verify deployment-specific
   database role permissions before applying the migration.
2. With authorization, apply migration 017 and deploy the MCP code. Review
   backend role ownership/grants. Never grant budget tables/functions to public
   or client roles and never add `jobs:worker` to a chat connector.
3. After the actual cost policy is approved, configure the MCP server:
   `HAIKU_BUDGET_CONTROLS_APPROVED=true` and
   `HAIKU_MONTHLY_LIMIT_MICRO_USD=<approved allowance>`. Valid range is
   5,000–30,000,000. Both reserve and claim enforce the runtime kill switch.
4. Set the GitHub repository variable `HAIKU_PAID_EXECUTION_APPROVED=true` only
   after the approval above. Keep `ANTHROPIC_API_KEY` in GitHub Secrets. The
   generic paid-provider flag and provider override cannot bypass these gates.
5. Run an authorized bounded smoke test, check the DB ledger and provider usage,
   then enable the desired workflow. The new workflow is manual-only and the
   existing schedule remains unchanged. Turning off either approval flag prevents
   new paid dispatches, apart from an HTTP request already in flight.

## Offline validation

Python tests use mock transports and synthetic jobs; no provider or auth calls.
They cover model selection, disabled defaults, request size, every HTTP failure,
no automatic retries, stale/mismatched claims, event-loop compatibility and
pending-queue preservation. MCP tests exercise authentication, strict inputs,
kill switches, SQL rollback, daily/monthly limits, one-use claims, owner/digest
binding, expiry, midnight, DST and month rollover.

PGlite serializes one embedded connection. Additional tests used PostgreSQL 18.6
in an isolated temporary local instance with the production migration unchanged:
75 distinct connections obtained exactly 50 daily grants and 25 denials; a
35,000-microUSD monthly allowance yielded seven grants and 68 denials; 75
simultaneous claims granted exactly one; forced insertion failure rolled back
both counters. A held lock confirmed reservations take database time after the
lock wait. The instance listened only on loopback and was stopped afterward.

No production migration, deployment, secret inspection, workflow dispatch or paid
smoke test was performed. Model/account access and billed usage remain untested.
