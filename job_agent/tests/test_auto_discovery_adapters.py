"""Network-isolated ATS adapter fixture parsing (Milestone 5)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import httpx

from job_agent.auto_discovery.adapters.registry import get_adapter
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.ranking import classify_location, persona_reject_reason
from job_agent.auto_discovery.types import CompanyRecord
from job_agent.profile.identity import load_active_profile

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ats"


def _mock_transport(url_suffix: str, payload: object) -> httpx.MockTransport:
    body = json.dumps(payload).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if url_suffix not in str(request.url):
            return httpx.Response(404, json={"error": "not found"})
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

    return httpx.MockTransport(handler)


class AdapterFixtureTests(unittest.TestCase):
    def test_greenhouse_fixture(self):
        payload = json.loads((FIXTURES / "greenhouse_jobs.json").read_text(encoding="utf-8"))
        transport = _mock_transport("/v1/boards/stripe/jobs", payload)
        http = SafeHttpClient(transport=transport, max_retries=0)
        adapter = get_adapter("greenhouse", http=http)
        company = CompanyRecord(
            id="1",
            company_key="stripe",
            company_name="Stripe",
            ats_provider="greenhouse",
            ats_org_id="stripe",
        )
        jobs = adapter.list_jobs(company)
        self.assertGreaterEqual(len(jobs), 1)
        self.assertEqual(jobs[0].source, "greenhouse")
        self.assertEqual(jobs[0].external_job_id, "1001")
        self.assertIn("Staff Platform", jobs[0].title)
        http.close()

    def test_ashby_fixture(self):
        payload = json.loads((FIXTURES / "ashby_jobs.json").read_text(encoding="utf-8"))
        transport = _mock_transport("/posting-api/job-board/notion", payload)
        http = SafeHttpClient(transport=transport, max_retries=0)
        adapter = get_adapter("ashby", http=http)
        company = CompanyRecord(
            id="1",
            company_key="notion",
            company_name="Notion",
            ats_provider="ashby",
            ats_org_id="notion",
        )
        jobs = adapter.list_jobs(company)
        self.assertEqual(jobs[0].source, "ashby")
        self.assertEqual(jobs[0].external_job_id, "ashby-1")
        self.assertTrue(jobs[0].description)
        self.assertEqual(jobs[0].location, "Remote, US")
        self.assertEqual(jobs[1].location, "")
        http.close()

    def test_ashby_remote_flag_preserves_geographic_scope(self):
        cases = [
            ("United States", True, "Remote - United States", "us"),
            ("New York, NY", True, "Remote - New York, NY", "us"),
            ("London, UK", True, "Remote - London, UK", "non_us"),
            ("", True, "Remote", "unknown"),
            ("REMOTE, US", True, "REMOTE, US", "us"),
            ("New York, NY", False, "New York, NY", "us"),
            ("Hybrid - San Francisco, CA", False, "Hybrid - San Francisco, CA", "us"),
            ("United States", "false", "United States", "us"),
            ("United States", None, "United States", "us"),
        ]
        company = CompanyRecord(
            id="1", company_key="acme", company_name="Acme",
            ats_provider="ashby", ats_org_id="acme",
        )
        for location, is_remote, expected, scope in cases:
            with self.subTest(location=location, is_remote=is_remote):
                job = {
                    "id": "remote-1", "title": "Senior Backend Engineer",
                    "jobUrl": "https://jobs.ashbyhq.com/acme/remote-1",
                    "location": location, "isRemote": is_remote,
                }
                http = SafeHttpClient(
                    transport=_mock_transport("/posting-api/job-board/acme", {"jobs": [job]}),
                    max_retries=0,
                )
                self.addCleanup(http.close)
                candidate = get_adapter("ashby", http=http).list_jobs(company)[0]
                self.assertEqual(candidate.location, expected)
                self.assertEqual(classify_location(candidate.location), scope)
                if scope == "non_us":
                    self.assertEqual(
                        persona_reject_reason(candidate, load_active_profile()),
                        "incompatible_location",
                    )
                if location == "New York, NY" and is_remote is True:
                    self.assertIsNone(persona_reject_reason(candidate, load_active_profile()))

    def test_lever_fixture(self):
        payload = json.loads((FIXTURES / "lever_jobs.json").read_text(encoding="utf-8"))
        transport = _mock_transport("/v0/postings/netflix", payload)
        http = SafeHttpClient(transport=transport, max_retries=0)
        adapter = get_adapter("lever", http=http)
        company = CompanyRecord(
            id="1",
            company_key="netflix",
            company_name="Netflix",
            ats_provider="lever",
            ats_org_id="netflix",
        )
        jobs = adapter.list_jobs(company)
        self.assertEqual(jobs[0].source, "lever")
        self.assertEqual(jobs[0].external_job_id, "lever-1")
        self.assertIn("Backend Engineer", jobs[0].title)
        http.close()


if __name__ == "__main__":
    unittest.main()
