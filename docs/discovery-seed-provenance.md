# SmartRecruiters seed provenance

PR #41 already merged 15 existing-provider boards, taking the seed catalog from 95 to 110. Their identity evidence and limitations remain in [existing-ATS seed provenance](existing-ats-seed-provenance.md). All 110 company objects, including those 15 additions, are preserved unchanged and in order.

This remaining expansion adds only Nexthink and Shippeo, taking the catalog from 110 to 112 and advancing its version to `seeds-v5`. No duplicate company key or ATS identity is added. Candidate hints still require runtime verification before promotion; a board or global posting count does not establish a matching US remote/hybrid vacancy.

## SmartRecruiters verification

Research date: 2026-11-09 (UTC). Unlike the initial 15 additions, these two boards were verified against the public JSON API using one bounded unauthenticated GET per exact, evidenced company identifier (`limit=5&offset=0`). No credentials or paid requests were used. `totalFound` is the API-wide count at verification, not a count of jobs matching the active profile, and can change. Runtime verification remains mandatory before promotion.

| Employer | Exact identifier | Official career evidence | API verification | Fit and limitations |
|---|---|---|---|---|
| Nexthink | `Nexthink` | https://nexthink.com/company/careers/jobs and https://careers.smartrecruiters.com/Nexthink | https://api.smartrecruiters.com/v1/companies/Nexthink/postings?limit=5&offset=0 returned HTTP 200, `totalFound: 64`; all five sampled postings identified company `Nexthink`. Sample ID `744000160189599`. | Digital employee-experience software company; relevant software/technology scaleup coverage rather than a general enterprise board. First five API results were US Enterprise Account Executive roles. Engineering fit and full descriptions were not checked in this bounded sample. |
| Shippeo | `Shippeo` | https://www.shippeo.com/company/careers and https://careers.smartrecruiters.com/Shippeo | https://api.smartrecruiters.com/v1/companies/Shippeo/postings?limit=5&offset=0 returned HTTP 200, `totalFound: 5`; all five identified company `Shippeo`. | Venture-backed transportation-visibility SaaS scaleup. Official careers site describes software engineering/data teams. API included Senior Software Engineer, Data (`744000140678199`) and Senior Data Integration Engineer (`744000154095629`), both Bengaluru, plus US commercial/solution-consulting roles. No US backend/AI engineering match is claimed. |

Tradeshift was checked at https://tradeshift.com/careers/ and https://careers.smartrecruiters.com/Tradeshift first. A single GET to https://api.smartrecruiters.com/v1/companies/Tradeshift/postings?limit=5&offset=0 returned HTTP 200 with `totalFound: 0` and an empty `content` list; the branded board likewise reported no postings. It was not added, avoiding an empty source being presented as increased job volume. SmartRecruiters' own employer site was inspected but no unambiguous live ATS identifier was established, so it was not added.
