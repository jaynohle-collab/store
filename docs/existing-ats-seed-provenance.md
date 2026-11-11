# Existing-ATS discovery seed provenance

Research date: 2026-11-09 (UTC).

## Scope and evidence

Added 15 identity-verified employer boards to the existing 95-entry catalog (110 total), using only the existing Greenhouse and Ashby adapters. Existing company entries are unchanged. These are candidate inventory additions, not enabled production sources or admitted jobs.

Discovery source: https://github.com/mherzog4/job-boards/blob/main/boards.seed.json (blob SHA `24b1562d8de642045179f67ddd8521104143cd6e`). Its identifiers were treated as leads, not proof. All additions were corroborated against public employer-owned ATS pages or indexed official postings. No third-party aggregator is a scan source.

**Verified:** employer identity, ATS hostname, and exact board slug, supported by the links below. Each Ashby board URL was opened and returned the employer-branded page title, with a JavaScript-only body. Indexed official posting evidence supplements those shells.

**Not verified:** live API JSON payloads, complete posting counts, continued availability of each indexed job, job fit, or successful production ingestion. Ashby posting API reads through the web tool returned inaccessible errors; a bounded unauthenticated urllib GET to https://api.ashbyhq.com/posting-api/job-board/hex returned HTTP 403 Forbidden. No retry or bypass was attempted. Figma API returned an application/json page without inspectable body. No API success or live job count is claimed. The existing expansion worker must verify every candidate through its official ATS endpoint before enabling it. Indexed crawl ages below are the search tool observations, not publication dates.

## Added boards

| Employer | Provider / exact identifier | Official evidence | Observation |
|---|---|---|---|
| Browserbase | `greenhouse` / `browserbaseinc` | [Board](https://job-boards.greenhouse.io/browserbaseinc); [posting or careers evidence](https://job-boards.greenhouse.io/browserbaseinc/jobs/4451753009) | Board opened with current Agent Platform and Core engineering roles; corroborated by https://www.browserbase.com/careers. |
| Hex | `ashby` / `hex` | [Board](https://jobs.ashbyhq.com/hex); [posting or careers evidence](https://jobs.ashbyhq.com/hex/b3921203-d928-40ac-9675-a58a9cdbaafa) | Indexed Software Engineer, Infrastructure posting (crawl: 2 weeks ago); official https://hex.tech/careers/ lists engineering roles. |
| Ashby | `ashby` / `ashby` | [Board](https://jobs.ashbyhq.com/ashby); [posting or careers evidence](https://jobs.ashbyhq.com/ashby/0f5dbf59-687b-4d88-88a7-73ee0a66b48d) | Indexed Staff Platform Engineer, Americas posting (crawl: last week); official https://www.ashbyhq.com/careers also checked. |
| Maybern | `ashby` / `maybern` | [Board](https://jobs.ashbyhq.com/maybern); [posting or careers evidence](https://jobs.ashbyhq.com/maybern/7f15f570-50a7-4a87-8c7e-8d66c556be5e/) | Indexed Senior Software Engineer posting (crawl: today). |
| Monte Carlo | `ashby` / `montecarlodata` | [Board](https://jobs.ashbyhq.com/montecarlodata); [posting or careers evidence](https://jobs.ashbyhq.com/montecarlodata/bee6315c-3bc5-49b8-a6c0-1c36b3b59de6/) | Indexed Applied AI Engineer posting explicitly identifies this board as its official careers page; direct posting shell also opened. |
| NewtonX | `ashby` / `newtonx` | [Board](https://jobs.ashbyhq.com/newtonx); [posting or careers evidence](https://jobs.ashbyhq.com/newtonx/463365ed-d5cc-48ae-97a1-ac4d1ac65dfe/) | Indexed Senior Staff Software Engineer posting (crawl: 3 weeks ago). |
| Middesk | `ashby` / `middesk` | [Board](https://jobs.ashbyhq.com/middesk); [posting or careers evidence](https://jobs.ashbyhq.com/middesk/e1c6af86-dce1-495f-a710-ad369fd1308c/) | Indexed Software Engineer posting (crawl: last week); official https://www.middesk.com/careers also checked. |
| Sardine | `ashby` / `sardine` | [Board](https://jobs.ashbyhq.com/sardine); [posting or careers evidence](https://jobs.ashbyhq.com/sardine/2524d206-42cb-4202-8d85-59e47c72d704) | Indexed Software Engineer, Backend posting (crawl: 2 weeks ago). |
| Deel | `ashby` / `deel` | [Board](https://jobs.ashbyhq.com/deel); [posting or careers evidence](https://jobs.ashbyhq.com/deel/6e93f93c-dcde-42c1-9b61-9a542de8cdbe) | Indexed AI Engineer, Backend posting (crawl: 5 months ago). Older evidence establishes identity only; live availability especially needs runtime verification. |
| Zip | `ashby` / `zip` | [Board](https://jobs.ashbyhq.com/zip); [posting or careers evidence](https://jobs.ashbyhq.com/zip/e7bcd788-ca5f-4e90-9728-0de7b57026a1) | Indexed Software Engineer, Backend posting (crawl: last week). |
| XBOW | `ashby` / `xbowcareers` | [Board](https://jobs.ashbyhq.com/xbowcareers); [posting or careers evidence](https://jobs.ashbyhq.com/xbowcareers/304f9f4e-477e-4d29-a39a-7c212738a0c8) | Indexed Software Engineer, AI Systems posting (crawl: last week). |
| Orum | `ashby` / `orum` | [Board](https://jobs.ashbyhq.com/orum); [posting or careers evidence](https://jobs.ashbyhq.com/orum/43f1083b-1ef8-4a42-925c-229b49d21b6b/) | Indexed Senior Software Engineer, Product Platform posting (crawl: yesterday). |
| Unit | `ashby` / `unit` | [Board](https://jobs.ashbyhq.com/unit); [posting or careers evidence](https://jobs.ashbyhq.com/unit/b05136a8-979d-43e4-9e42-a20c767ff7bc/) | Indexed GTM Lead posting (crawl: last week) establishes fintech employer identity. No matching engineering vacancy verified. |
| Protege | `ashby` / `protege` | [Board](https://jobs.ashbyhq.com/protege); [posting](https://jobs.ashbyhq.com/protege/f8b0350b-c5e3-447d-8d01-04bfc5e04f22) | Indexed AI Engineer, New Verticals (crawl: last month); branded board opened. |
| Swarm Aero | `ashby` / `swarmaero` | [Board](https://jobs.ashbyhq.com/swarmaero); [posting](https://jobs.ashbyhq.com/swarmaero/0ab05da6-7a1b-4632-b08f-0ef663efb33f/) | Indexed Software Engineer, Real-Time Generalist (crawl: yesterday); branded board opened. |

## Rejected or deferred upstream leads

- Figma and Ramp: official evidence found, but already registered by migration 010. Excluded to preserve the catalog no-duplicates contract.

- Browserbase: upstream lists Ashby `browserbase`, but its current official careers page matches the directly readable Greenhouse `browserbaseinc` board. Added the latter only, avoiding a stale alternate board.
- Warp: Ashby `warp` is the payroll/employee-management company, not the terminal at warp.dev. An indexed Applied AI posting returned 404 on direct open. No ambiguous Warp entry was added.
- Airtable and Pave: branded shells were visible, but this pass did not establish sufficiently clear recent posting evidence. Not added.
- Ro: the direct Lever board returned HTTP 403; no retry or alternate access path was used. Not added.
- Other upstream leads were not exhaustively verified and were not imported.

## Validation

The initial source research passed all 10 expansion tests. For the seed-only split on 2026-11-11, `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s job_agent/tests -p "*expansion*" -v` passed all 12 tests, including exact board identities and bounded batching of the full catalog. A separate baseline comparison confirmed that all 95 original company objects are unchanged. `git diff --check` passed. These tests do not establish network/API health. No applications, candidate submissions, paid requests, credential use, or external state writes were performed.

## Rollout boundaries

This data-only expansion uses providers accepted by the current candidate schema and public ATS adapters. It requires no database migration, provider implementation, new credential, or hosting setting change. It does not change profiles, ranking, US location eligibility, remote/hybrid admission, or per-run limits. New entries are only candidate hints until the existing expansion worker verifies and promotes them. Employer identity does not establish a currently open US remote/hybrid role.

The next scheduled expansion after a merge can offer all 110 seeds in existing bounded batches of 100 and 10, then verify up to the configured per-run limit. Existing candidates and company registry entries are deduplicated and their state is preserved. A catalog rollback alone does not remove already inserted candidates or promoted boards; disabling a problematic promoted board is a separate operational action.

This is the existing-provider subset of PR #40. The SmartRecruiters adapter and migration 016 remain deferred. Before combining the larger PR later, reconcile the catalog and its version with this expansion rather than reintroducing duplicate entries.
