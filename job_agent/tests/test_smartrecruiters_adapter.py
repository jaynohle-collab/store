"""Network-isolated coverage of public SmartRecruiters discovery."""

import unittest

import httpx

from job_agent.auto_discovery.adapters.registry import get_adapter, supported_providers
from job_agent.auto_discovery.expansion import history_candidates, parse_ats_posting_url, verify_candidate
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.ranking import classify_location, persona_reject_reason
from job_agent.auto_discovery.ssrf import assert_safe_ats_url
from job_agent.auto_discovery.types import AdapterError, CompanyRecord
from job_agent.profile.identity import load_active_profile


COMPANY = CompanyRecord(id="test", company_key="acme", company_name="Acme",
                        ats_provider="smartrecruiters", ats_org_id="Acme")


def posting(job_id=123, **changes):
    return {"id": str(job_id), "name": "Senior Backend Engineer", "active": True,
            "company": {"identifier": "Acme", "name": "Acme"},
            "location": {"city": "New York", "region": "NY", "country": "us", "remote": True},
            "releasedDate": "2026-11-09T01:00:00Z", **changes}


class SmartRecruitersTests(unittest.TestCase):
    def adapter(self, handler):
        self.http = SafeHttpClient(transport=httpx.MockTransport(handler), max_retries=0)
        self.addCleanup(self.http.close)
        return get_adapter("smartrecruiters", http=self.http)

    def test_registry_and_paged_list_are_read_only_bounded_and_deduped(self):
        requests = []
        pages = {0: [posting(1), posting(2)], 2: [posting(2), posting(3)], 4: [posting(4)]}

        def handler(req):
            requests.append(req)
            self.assertEqual(req.method, "GET")
            self.assertNotIn("authorization", req.headers)
            self.assertNotIn("x-smarttoken", req.headers)
            self.assertEqual(req.url.host, "api.smartrecruiters.com")
            self.assertEqual(req.url.path, "/v1/companies/Acme/postings")
            offset = int(req.url.params["offset"])
            return httpx.Response(200, json={"content": pages[offset], "totalFound": 5})

        adapter = self.adapter(handler)
        adapter.max_listings = 5
        jobs = adapter.list_jobs(COMPANY)
        self.assertIn("smartrecruiters", supported_providers())
        self.assertEqual([j.external_job_id for j in jobs], ["1", "2", "3", "4"])
        self.assertEqual([int(r.url.params["offset"]) for r in requests], [0, 2, 4])
        self.assertEqual([int(r.url.params["limit"]) for r in requests], [5, 3, 1])
        self.assertEqual(jobs[0].url, "https://jobs.smartrecruiters.com/Acme/1")
        self.assertEqual(jobs[0].posted_date, "2026-11-09")
        self.assertEqual(jobs[0].client_candidate_id, "smartrecruiters:Acme:1")

    def test_overlong_page_does_not_exceed_raw_listing_cap(self):
        adapter = self.adapter(lambda req: httpx.Response(200, json={
            "content": [posting(n) for n in range(5)], "totalFound": 1000000}))
        adapter.max_listings = 3
        self.assertEqual(len(adapter.list_jobs(COMPANY)), 3)
        self.assertEqual(self.http.stats["requests"], 1)

    def test_zero_budget_does_not_request(self):
        adapter = self.adapter(lambda req: self.fail("must not request"))
        adapter.max_listings = 0
        self.assertEqual(adapter.list_jobs(COMPANY), [])

    def test_repeated_page_and_missing_total_terminate(self):
        for total in (None, 1000000):
            with self.subTest(total=total):
                payload = {"content": [posting()]}
                if total is not None:
                    payload["totalFound"] = total
                adapter = self.adapter(lambda req: httpx.Response(200, json=payload))
                self.assertEqual(len(adapter.list_jobs(COMPANY)), 1)
                self.assertLessEqual(self.http.stats["requests"], 2)

    def test_invalid_closed_private_and_mismatched_listings_are_skipped(self):
        payload = {"content": [None, posting(id="../evil"), posting(2, name=""),
                               posting(3, active=False), posting(4, visibility="INTERNAL"),
                               posting(5, company={"identifier": "Other"}), posting(6)]}
        adapter = self.adapter(lambda req: httpx.Response(200, json=payload))
        self.assertEqual([j.external_job_id for j in adapter.list_jobs(COMPANY)], ["6"])

    def test_company_identifier_rejects_path_injection_before_network(self):
        adapter = self.adapter(lambda req: self.fail("must not request"))
        for org in ("", "..", "../Acme", "Acme?internal=true", "a/b", "a@evil.com"):
            with self.subTest(org=org), self.assertRaises(AdapterError):
                adapter.list_jobs(CompanyRecord("1", "a", "A", "smartrecruiters", org))

    def test_location_scope_is_preserved_and_non_us_rejected(self):
        for location, expected_scope, prefix in (
            ({"country": "us", "remote": True}, "us", "Remote"),
            ({"country": "us", "city": "New York", "hybrid": True}, "us", "Hybrid"),
            ({"country": "ca", "remote": True}, "non_us", "Remote"),
            ({"country": "gb", "remote": True}, "non_us", "Remote"),
            ({"country": "in", "remote": True}, "non_us", "Remote"),
            ({"country": "ca", "city": "Victoria", "region": "CA", "remote": True}, "non_us", "Remote"),
            ({"country": "it", "city": "Florence", "region": "SC", "remote": True}, "non_us", "Remote"),
            ({"country": "us", "remote": True, "hybrid": True}, "us", "Hybrid"),
            ({"remote": True}, "unknown", "Remote"),
            ({}, "unknown", ""),
        ):
            with self.subTest(location=location):
                adapter = self.adapter(lambda req: httpx.Response(200, json={"content": [posting(location=location)]}))
                job = adapter.list_jobs(COMPANY)[0]
                self.assertTrue(job.location.startswith(prefix))
                self.assertEqual(classify_location(job.location), expected_scope)
                if expected_scope == "non_us":
                    self.assertEqual(persona_reject_reason(job, load_active_profile()), "incompatible_location")

    def test_detail_reads_documented_path_and_preserves_description_and_url(self):
        seen = []
        def handler(req):
            seen.append(req)
            if req.url.path.endswith("/123"):
                return httpx.Response(200, json=posting(
                    applyUrl="https://jobs.smartrecruiters.com/Acme/123-senior-engineer?source=career",
                    jobAd={"sections": {
                        "jobDescription": {"text": "<p>Build <b>AI</b> systems &amp; APIs.</p>"},
                        "qualifications": {"text": "Python experience."},
                        "additionalInformation": {"text": "Hybrid in New York."},
                    }},
                ))
            return httpx.Response(200, json={"content": [posting(ref="https://evil.example/secret")]})
        adapter = self.adapter(handler)
        job = adapter.get_job(COMPANY, adapter.list_jobs(COMPANY)[0])
        self.assertEqual(seen[-1].url.path, "/v1/companies/Acme/postings/123")
        self.assertEqual(job.description, "Build AI systems & APIs.\nPython experience.\nHybrid in New York.")
        self.assertIn("/123-senior-engineer", job.url)
        self.assertEqual(job.external_job_id, "123")

    def test_untrusted_application_links_fall_back_to_matching_official_posting(self):
        for url in ("https://evil.example/123", "https://jobs.smartrecruiters.com.evil.example/Acme/123",
                    "https://api.smartrecruiters.com/v1/companies/Acme/postings/123",
                    "https://jobs.smartrecruiters.com/Other/123", "https://jobs.smartrecruiters.com/Acme/999",
                    "https://user@jobs.smartrecruiters.com/Acme/123", "https://jobs.smartrecruiters.com:444/Acme/123"):
            with self.subTest(url=url):
                adapter = self.adapter(lambda req: httpx.Response(200, json={"content": [posting(applyUrl=url)]}))
                self.assertEqual(adapter.list_jobs(COMPANY)[0].url, "https://jobs.smartrecruiters.com/Acme/123")

    def test_closed_private_mismatched_detail_cannot_be_returned(self):
        for changes in ({"active": False}, {"visibility": "INTERNAL"}, {"id": "456"},
                        {"company": {"identifier": "Other"}}):
            with self.subTest(changes=changes):
                def handler(req):
                    return httpx.Response(200, json=posting(**changes) if req.url.path.endswith("/123") else {"content": [posting()]})
                adapter = self.adapter(handler)
                candidate = adapter.list_jobs(COMPANY)[0]
                with self.assertRaises(AdapterError):
                    adapter.get_job(COMPANY, candidate)

    def test_malformed_response_and_http_errors_are_classified(self):
        for status, payload, category in ((200, {}, "validation"), (404, {}, "not_found"),
                                          (429, {}, "rate_limit"), (503, {}, "server_error")):
            with self.subTest(status=status):
                adapter = self.adapter(lambda req: httpx.Response(status, json=payload))
                with self.assertRaises(AdapterError) as caught:
                    adapter.list_jobs(COMPANY)
                self.assertEqual(caught.exception.category, category)

    def test_non_json_response_validation(self):
        adapter = self.adapter(lambda req: httpx.Response(200, text="not json"))
        with self.assertRaises(AdapterError) as caught:
            adapter.list_jobs(COMPANY)
        self.assertEqual(caught.exception.category, "validation")

    def test_expansion_uses_bounded_verification(self):
        self.adapter(lambda req: httpx.Response(200, json={"content": [posting(n) for n in range(100)], "totalFound": 100}))
        result = verify_candidate({"ats_provider": "smartrecruiters", "ats_org_id": "Acme",
                                   "company_key": "acme", "company_name": "Acme"}, self.http)
        self.assertEqual((result.outcome, result.job_count), ("verified", 20))

    def test_history_parses_exact_posting_urls_only(self):
        for host in ("www.smartrecruiters.com", "jobs.smartrecruiters.com"):
            self.assertEqual(parse_ats_posting_url(f"https://{host}/Acme/123-job-title?source=x"), ("smartrecruiters", "Acme"))
        for url in ("https://careers.smartrecruiters.com/Acme", "https://jobs.smartrecruiters.com/Acme",
                    "https://jobs.smartrecruiters.com.evil.example/Acme/123",
                    "https://api.smartrecruiters.com/v1/companies/Acme/postings/123",
                    "https://jobs.smartrecruiters.com/Acme/123/other", "http://jobs.smartrecruiters.com/Acme/123"):
            with self.subTest(url=url):
                self.assertIsNone(parse_ats_posting_url(url))
        candidates = history_candidates([
            {"url": "https://jobs.smartrecruiters.com/Acme/123", "company": "Acme"},
            {"url": "https://www.smartrecruiters.com/acme/456", "company": "Acme"},
        ], limit=10)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["careers_url"], "https://careers.smartrecruiters.com/Acme")

    def test_smartrecruiters_ssrf_uses_exact_hosts(self):
        for host in ("api.smartrecruiters.com", "jobs.smartrecruiters.com", "www.smartrecruiters.com", "careers.smartrecruiters.com"):
            assert_safe_ats_url(f"https://{host}/Acme")
        for host in ("api.smartrecruiters.com.evil.example", "evil.smartrecruiters.com", "smartrecruiters.com"):
            with self.subTest(host=host), self.assertRaises(AdapterError):
                assert_safe_ats_url(f"https://{host}/Acme")


if __name__ == "__main__":
    unittest.main()
