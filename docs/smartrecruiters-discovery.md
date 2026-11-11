# SmartRecruiters source expansion

Reconciled with repository main `d5dd4b33d21374c1f4ea6f68e4c7478983d6f8d6` after PR #41. The existing 110 seeds and the catalog batching/identity tests from that PR are retained.

## Behavior

- Adds the documented, unauthenticated public company Posting API. Only GET
  requests are made. No credentials, internal-posting access, paid API, or
  application-submission endpoint is used.
- Lists jobs in pages of at most 100, with the existing per-company listing
  budget. Raw rows, duplicates and malformed records all consume the bound.
  Empty/repeated pages stop pagination. Full descriptions are fetched only for
  the existing pipeline's selected postings.
- Fetches details from a fixed official API host and validated company/job IDs,
  never an upstream `ref` URL. Private, inactive, or identity-mismatched detail
  responses cannot advance to evaluation.
- Outputs matching official applicant posting links on
  `jobs.smartrecruiters.com` or `www.smartrecruiters.com`. When the API listing
  omits `applyUrl`, the canonical numeric posting URL is used. API and company
  landing pages are not admitted as applicant links.
- Retains structured country scope, remote/hybrid flags, and full description
  sections. Explicit country codes take precedence over ambiguous city/state
  text. A remote flag alone does not establish US eligibility. Existing profile,
  remote/hybrid eligibility, scoring, deduplication, and admission gates remain
  in force; none of their thresholds or preferences are changed.
- Expands candidate seed inventory from 110 to 112, preserving all existing
  employer entries and adding only Nexthink and Shippeo. These two boards
  returned valid public API payloads with 64 and 5 total postings
  on 2026-11-09. These are global counts across all roles, not qualifying US
  remote/hybrid matches. See [seed provenance](discovery-seed-provenance.md).

## Local validation and limits

Network-isolated tests cover pagination, malformed payloads, deduplication,
read-only/no-auth requests, private/closed postings, company/job identity,
country ambiguity, bounded verification, hostile URLs, candidate promotion,
posting hints, and migration idempotency/state preservation.

Live read-only checks confirmed the documented SmartRecruiters public list and
detail endpoints, an active public posting, and the canonical numeric applicant
URL without a title slug. All returned HTTP 200 without credentials. These
checks did not write to the deployed MCP/database or run the live pipeline.
The local production HTTP client could not perform an end-to-end live adapter
probe because the environment's SOCKS proxy requires the absent `socksio`
dependency. Live endpoint checks used ordinary bounded HTTPS reads instead.

Validation results:

- Focused Python adapter/expansion/ranking/HTTP tests: 46 passed.
- Full Remote MCP `npm test -- --maxWorkers=1`: 56 files, 549 tests passed.
- Full Python suite: 241 tests attempted, 35 failures and 12 errors. Unmodified
  main attempted 226 with the identical failing-test set. The environment lacks
  `mcp.Client` expected by the repository and the SOCKS `socksio` dependency.
- TypeScript `tsc --noEmit`: the same 17 diagnostics as unmodified main. These
  are existing tests with a non-tuple spread, missing `deferred` arguments, and
  regex flags incompatible with the configured target; none are in changed files.
- Independent code review and `git diff --check` passed.

Those are the original local-environment results. The original PR head subsequently passed GitHub CI: all 340 Python tests, 549 Remote MCP tests, and the production Next.js build. Reconciled-head CI must pass again before integration; this conflict resolution does not change runtime code or repair unrelated local dependency issues.

## Deployment order (not performed)

1. Review passing CI on the exact reconciled head. Do not merge yet: main is
   connected to automatic deployment. The current main rules require linear
   history, so any later authorized integration must use a supported squash or
   rebase merge without bypassing rules.
2. Before merging, verify the production database identity, current candidate
   provider constraint, and lack of active discovery workers. Apply
   `remote_mcp/migrations/016_smartrecruiters_company_candidates.sql` only with
   separate rollout authorization and bounded lock/statement timeouts, then
   verify the resulting `discovery_company_candidates_provider_check`. The
   migration only expands accepted providers and preserves existing rows and
   candidate state. Migration 015 is not a dependency. No migration was run.
3. After migration verification, merge only when production rollout is
   authorized. Wait for the matching Remote MCP deployment and health check
   before permitting the updated producer to submit SmartRecruiters candidates.
   The API and database must both accept the provider before its seed batch is
   sent. Coordinate the scheduled producer to avoid a deployment race.
4. Let the updated producer offer the reconciled seed catalog with normal
   budgets and verification enabled. Each of the two new candidates still needs
   successful public ATS API verification before becoming enabled. Verification
   may take multiple scheduled runs because of per-run bounds and pending work.
5. Inspect expansion outcomes and discovery metrics separately: boards verified,
   listings fetched, descriptions evaluated, and qualifying jobs admitted.
   Existing budgets are unchanged, so inventory breadth does not guarantee
   increased admitted job volume in a single run.

If rolling back application code, the expanded provider constraint can remain.
An older producer cannot scan SmartRecruiters companies, so disable or defer
those two sources before running an older producer if they were already enabled.
No rollback or live state change was performed as part of this patch.

## Primary API references

- https://developers.smartrecruiters.com/docs/endpoints
- https://developers.smartrecruiters.com/docs/posting-api

The API also supports authenticated access to internal postings. This adapter
does not provide authentication and explicitly rejects non-public responses.
