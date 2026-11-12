# Keyword-first discovery and review

## Status

Implemented: a deterministic matcher, separate producer mode, authenticated
MCP/storage path, migration 019, and a read-only dashboard at
`/dashboard/keyword-review`. Deployment, database migration, runtime configuration,
and live verification are separate rollout steps. Adding these files alone does
not enable keyword discovery.

No personal search preferences are included in this patch. A private keyword
policy is required. New functionality does not create applications, change
application statuses, fake GPT evidence, or use a paid model. Optional AI
keyword suggestions/enrichment are a future separate feature, not an automatic
background action implemented here.

## Why a separate lane

The existing producer already ranks listings deterministically but then selects
at most 3–5/company for full-description/LLM evaluation. Only `QUALIFIED`
evidence reaches the existing inbox. A provider outage queues candidates for
future AI review rather than showing them to a person.

Keyword mode does not disable `DISCOVERY_REQUIRE_GPT_EVALUATION`, forge
`gpt_decision=QUALIFIED`, or replace a GPT score with a keyword score. It uses
separate storage and UI, retaining existing auth, network restrictions, rate
limits, GPT admission contracts, lifecycle rules and spending controls.

## Implemented flow

1. Explicit keyword-mode selection and valid private policy are required.
   Default mode remains `gpt` for backward-compatible, controlled rollout.
2. Claim due registered companies through the existing authenticated control
   plane; fetch bounded listings with the existing official ATS adapters and
   SafeHttpClient. No aggregators, arbitrary crawling or access workarounds.
3. Score listing snapshots without fetching every full description or resolving
   an LLM provider. Missing description is visible, not an admission failure.
4. Run read-only identity/application preflight. Ignore historical GPT rejection
   and GPT-skip fields for keyword admission. A preflight failure does not
   bypass access control or silently fall back to another path.
5. Send all distinct records in the bounded scan to the new review MCP tool in
   chunks of 100, including an inspectable filtered audit bucket. No top-K
   selection or LLM-evaluation budget limits review-list admission.
6. Store source metadata, matched terms, policy identity, first/last collection
   timestamps and per-run observations. Profile-scoped URL/ATS aliases dedupe
   repeat sightings; the same run UUID is idempotent. Existing canonical jobs,
   applications, GPT evidence and the old discovery inbox are untouched.
7. Show matching, broader, and needs-checking lists in the authenticated dashboard,
   newest additions first. Filtered rows are only shown when explicitly selected.
   Search and 50-row pagination are read-only. Links open the supplied external
   employer/ATS posting; authenticity and redirects are not claimed verified.

The CLI forcibly skips old inbox processing in keyword mode even when old flags
or environment settings requested it. The workflow's separate inbox step also
skips keyword mode. Existing AI-pending rows are not resumed by keyword runs.

## Meaning of labels and newness

Every row is **Keyword match, unverified**. The 0–100 score measures literal
text overlap, not eligibility, qualification, suitability probability or verified
availability. Location/country/work-mode fields are listing signals only.

`Remote` alone never implies US eligibility; a city never implies onsite. Missing,
mixed, unrecognized or negated location claims remain unknown. Explicit
mismatches and exclusion phrases are retained in the filtered audit bucket.
Ambiguous seniority and missing descriptions stay visible under needs-checking.

`New to review` means one collection-run sighting, not newly posted by the
employer. `Seen before` means multiple collection runs. First-added/last-collected
dates appear separately from the employer-supplied date. Opening the dashboard
does not mark jobs read. An old listing can be new to this collection; no claim
of genuine employer posting freshness is made without source evidence.

Application-history absence is `not_checked`. No match in the supplied/preflight
snapshot does not prove the user never applied. Known applied matches remain in
the audit bucket and do not trigger any application action.

## Private policy and initial thresholds

Supply `KEYWORD_REVIEW_POLICY_JSON` through approved private runtime storage, or
use `--keyword-policy /private/policy.json`. No bundled user-specific policy is
loaded as a fallback. `KEYWORD_REVIEW_PROFILE_ID` can override the existing active
profile identity and should match the server/dashboard setting.

Policy fields:

- Required: `policy_version` and at least one `role_terms` phrase or nonempty
  `keyword_groups` synonym group.
- Phrase arrays: `role_terms`, `seniority_terms`, `excluded_title_terms`.
- `keyword_groups`: category names mapped to arrays of synonymous phrases.
- `countries`: optional two-letter country-code array; empty means no country
  preference, not worldwide eligibility.
- `work_modes`: optional remote, hybrid, and/or onsite array.
- `minimum_score` (default 20), `stronger_score` (default 50).

Scoring: title-role phrase 40; each distinct keyword group 5, capped at 30;
configured seniority in title 10; matching listing country 10; matching listing
work mode 10. Synonyms in one group count once, using word/phrase boundaries.
At least one role/keyword hit is required. No legacy pure-DevOps or frontend
exclusion is imported implicitly; exclusions are explicit private policy terms.

20/50 are initial browse/stronger-overlap thresholds, not empirically calibrated
quality levels. A title-role match stays browsable without an AI decision.
Keyword-only matches need four groups to reach 20; audit missed niche roles and
consider 5/10 if recall suffers. Do not change a GPT-fit threshold to tune this
separate score. User selection feedback, manual sampling, and versioned keyword
diffs should guide tuning; no numerical production uplift has been established.

A content fingerprint accompanies the policy version. It is an identifier, not
anonymization. Policy fields, matched terms and reports remain private and must
not be copied into public repositories, CI logs or shared previews. Invalid
private-policy errors are deliberately generic.

## CLI and offline review

After the server/migration/configuration rollout is authorized:

```sh
python -m job_agent.examples.automatic_discovery_run \
  --mode keyword --max-companies 5 --keyword-policy /private/policy.json
```

This command performs live authorized source reads and review-storage writes;
do not run it merely to test an offline patch. Tests inject fake adapters/stores.

For saved snapshots without network or storage:

```sh
python -m job_agent.examples.keyword_review \
  --candidates /private/saved-listings.json \
  --policy /private/policy.json \
  --applied-urls /private/applied-urls.json \
  --output /private/review.json
```

Listing input is a JSON array with title/company/source/url and optional
external_job_id/location/description/posted_date. `--applied-urls` is optional.
The offline CLI uses exclusive creation and owner-only permissions. No raw
job descriptions are emitted into reports. It accepts up to 20,000 rows and
32 MiB input files. Python and TypeScript share a synthetic contract fixture.

## Migration and rollout order

1. Review the generic code before release. Do not commit private policy data,
   credentials, actual application history, or collected personal reports.
2. Apply `remote_mcp/migrations/019_keyword_review.sql` using the normal approved
   migration flow. No change to existing GPT-fit thresholds is required.
   This migration adds only review tables/function/indexes and does not backfill
   or alter applications, canonical jobs or GPT evidence.
3. Deploy server/MCP/dashboard code, retaining existing authentication. Missing
   migration is shown as unavailable, not false success. Verify anonymous access
   is denied and authenticated review reads work.
4. Configure the private policy, matching profile identity, and
   `AUTO_DISCOVERY_MODE=keyword`. Keep the scheduled workflow disabled or old
   mode until all prerequisites are ready. No model-budget increase is needed.
5. Authorize a small live canary. Verify known/new duplicates, history annotations,
   zero model calls, no inbox/app mutations, URLs, timestamps and actual rendered
   dashboard behavior. Only then switch the existing authorized schedule.
6. Audit other schedules before migration is considered complete: the legacy
   `daily-job-discovery.yml` has an independent enable flag and can still call
   models; the separate inbox processor also has its own schedule. This patch
   does not silently change those settings. Confirm the intended existing-mode
   schedules during the authorized rollout.
7. Review unique new-to-review counts and useful user selections, not fetched
   listing totals. Repeated scans do not establish newly posted jobs.

Rollback: switch scheduling off or explicitly back to the previous mode only
with authorization; do not silently fall back to AI when keyword setup fails.
Keep review data for recovery. Hiding/removing the new UI requires no destructive
application or canonical-data changes. Existing model spend approvals remain
unchanged; AI assistance would need its own bounded activation and policy flow.

## Known limitations and follow-up work

- Source collection and database hosting still use their normal infrastructure
  quotas/costs; zero model calls does not mean unlimited or cost-free discovery.
- Scans are still bounded by current company/listing limits. Workday and
  SmartRecruiters first-page limits are not solved here; a rotating local window
  cannot reach inventory an adapter never fetched. Expand sources/pagination
  separately with rate-limit and source-quality checks.
- The conservative country parser intentionally leaves city/state and unfamiliar
  country strings unknown. Keyword matching can misread negated skills, boilerplate,
  unusual titles and mixed listings; the user makes the final judgment.
- The review store dedupes exact source/URL identities, not fuzzy company-title
  similarity across distinct postings. It does not invent canonical/repost status.
- Application history can become stale after collection. Any later application
  workflow must refresh authoritative history and remain separately authorized.
- Source disappearance does not automatically close a stored review row. Last-seen
  timestamps expose age; active/open status stays unverified.
- Policy edits update snapshots without resetting original first-seen history.
  Automatic keyword suggestions, review-selection feedback persistence, semantic
  annotations and pending-queue backfill are not implemented.
- Local unit/PGlite/server-render tests are not live production verification or
  browser visual/interaction QA. Validate browser controls during an authorized
  canary, including pagination, repeated filters and Back/Forward.
