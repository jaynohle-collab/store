# SmartRecruiters source expansion

Based on repository main `78ffd63023f30683b6ef3150985a31c4c30d248f`.

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
- Expands candidate seed inventory from 95 to 112. The 17 added employer board
  identities were corroborated with official ATS pages. Nexthink and Shippeo
  additionally returned valid public API payloads with 64 and 5 total postings
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

This source patch does not claim a green full build or repair unrelated
dependency/test problems.

## Deployment order (not performed)

1. Review and merge the source change only when publication/deployment is
   authorized. Resolve required CI failures in the proper dependency environment.
2. Apply `remote_mcp/migrations/016_smartrecruiters_company_candidates.sql` to the
   intended database. It only replaces the candidate provider CHECK constraint;
   the enabled-company registry already supports SmartRecruiters. It preserves
   rows, preferences, statuses and all previously accepted providers, and is
   safe to reapply. Migration 015 is intentionally not included: it belongs to
   separate unmerged work and is not a dependency of 016.
3. Deploy the matching Remote MCP build before running the updated producer.
   The API must accept SmartRecruiters candidate upserts and its database must
   accept the provider before the seed batch can be sent. Otherwise the new
   seed batch can fail validation instead of expanding the inventory.
4. Use the updated Python producer and seed catalog. Run the existing company
   expansion with normal budgets and verification enabled. Each candidate still
   needs a successful public ATS API verification before it becomes enabled;
   no seed addition bypasses that check. The 17 additions can take multiple
   runs to verify under the current per-run bound and any older pending backlog.
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
