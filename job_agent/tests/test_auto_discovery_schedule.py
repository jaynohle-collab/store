"""Network-isolated tests for deterministic rejects + SSRF (Milestone 5)."""

from __future__ import annotations

import unittest

from job_agent.auto_discovery.deterministic import deterministic_reject_reason
from job_agent.auto_discovery.ssrf import assert_safe_ats_url
from job_agent.auto_discovery.types import AdapterError, LightweightCandidate


def _cand(**kwargs) -> LightweightCandidate:
    base = dict(
        client_candidate_id="c1",
        company="Acme",
        title="Staff Engineer",
        url="https://boards.greenhouse.io/acme/jobs/1",
        source="greenhouse",
        external_job_id="1",
    )
    base.update(kwargs)
    return LightweightCandidate(**base)


class DeterministicRejectTests(unittest.TestCase):
    def test_closed_title_rejected(self):
        reason = deterministic_reject_reason(_cand(title="Role (Filled)"))
        self.assertIsNotNone(reason)
        self.assertIn("closed", reason.lower())

    def test_non_http_url_rejected(self):
        reason = deterministic_reject_reason(_cand(url="ftp://example.com/job"))
        self.assertEqual(reason, "non-http url")

    def test_missing_identity_rejected(self):
        reason = deterministic_reject_reason(
            _cand(url="https://example.com", external_job_id="", title="Eng")
        )
        self.assertEqual(reason, "missing posting identity")

    def test_valid_candidate_passes(self):
        self.assertIsNone(deterministic_reject_reason(_cand()))


class SsrfGuardTests(unittest.TestCase):
    def test_allows_greenhouse_api(self):
        url = assert_safe_ats_url(
            "https://boards-api.greenhouse.io/v1/boards/stripe/jobs"
        )
        self.assertTrue(url.startswith("https://"))

    def test_blocks_http(self):
        with self.assertRaises(AdapterError) as ctx:
            assert_safe_ats_url("http://boards-api.greenhouse.io/v1/boards/x/jobs")
        self.assertEqual(ctx.exception.category, "ssrf_blocked")

    def test_blocks_unknown_host(self):
        with self.assertRaises(AdapterError) as ctx:
            assert_safe_ats_url("https://evil.example/steal")
        self.assertEqual(ctx.exception.category, "ssrf_blocked")

    def test_blocks_arbitrary_careers_host_bypass(self):
        with self.assertRaises(AdapterError) as ctx:
            assert_safe_ats_url(
                "https://www.shopify.com/careers",
                careers_host="www.shopify.com",
            )
        self.assertEqual(ctx.exception.category, "ssrf_blocked")

    def test_blocks_private_ipv4_and_ipv6(self):
        for url in (
            "https://127.0.0.1/x",
            "https://10.0.0.1/x",
            "https://192.168.1.1/x",
            "https://172.16.0.1/x",
            "https://[::1]/x",
            "https://[fc00::1]/x",
        ):
            with self.assertRaises(AdapterError) as ctx:
                assert_safe_ats_url(url)
            self.assertEqual(ctx.exception.category, "ssrf_blocked")


if __name__ == "__main__":
    unittest.main()
