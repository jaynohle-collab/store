"""Company expansion: seed catalog, history URL parsing, bounded verification.

Network-isolated: httpx MockTransport and fake stores only.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import httpx

from job_agent.auto_discovery.expansion import (
    CompanyExpansionWorker,
    history_candidates,
    load_seed_catalog,
    parse_ats_posting_url,
    verify_candidate,
)
from job_agent.auto_discovery.http_client import SafeHttpClient
from job_agent.auto_discovery.limits import DiscoveryLimits

UUID = "0f3a1b2c-1234-4abc-8def-0123456789ab"


class ParseTests(unittest.TestCase):
    def test_official_ats_urls(self):
        self.assertEqual(
            parse_ats_posting_url("https://boards.greenhouse.io/Anthropic/jobs/123?gh_src=x"),
            ("greenhouse", "anthropic"),
        )
        self.assertEqual(
            parse_ats_posting_url("https://job-boards.greenhouse.io/vercel/jobs/42"),
            ("greenhouse", "vercel"),
        )
        self.assertEqual(
            parse_ats_posting_url(f"https://jobs.ashbyhq.com/cohere/{UUID}"), ("ashby", "cohere")
        )
        self.assertEqual(
            parse_ats_posting_url(f"https://jobs.lever.co/palantir/{UUID}/apply"),
            ("lever", "palantir"),
        )
        self.assertEqual(
            parse_ats_posting_url(
                "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Engineer_R1"
            ),
            ("workday", "acme|External|acme.wd5.myworkdayjobs.com"),
        )

    def test_rejects_non_official_or_ambiguous_urls(self):
        for url in (
            "http://boards.greenhouse.io/acme/jobs/1",
            "https://boards.greenhouse.io/acme",
            "https://boards.greenhouse.io.evil.com/acme/jobs/1",
            "https://evil.com/boards.greenhouse.io/acme/jobs/1",
            "https://jobs.ashbyhq.com/acme",
            "https://jobs.lever.co/acme/not-a-uuid",
            "https://www.linkedin.com/jobs/view/1",
            "https://careers.acme.com/jobs/1",
            "",
        ):
            with self.subTest(url=url):
                self.assertIsNone(parse_ats_posting_url(url))

    def test_history_candidates_dedupe_and_bound(self):
        hints = [
            {"url": "https://boards.greenhouse.io/acme/jobs/2", "company": "Acme AI"},
            {"url": "https://boards.greenhouse.io/ACME/jobs/1", "company": "Acme AI"},
            {"url": f"https://jobs.ashbyhq.com/beta/{UUID}", "company": "Beta"},
            {"url": "https://careers.gamma.com/1", "company": "Gamma"},
        ]
        out = history_candidates(hints, limit=10)
        self.assertEqual(
            [(c["ats_provider"], c["ats_org_id"], c["company_key"]) for c in out],
            [("ashby", "beta", "beta"), ("greenhouse", "acme", "acme-ai")],
        )
        self.assertTrue(all(c["discovery_source"] == "posting_history" for c in out))
        self.assertEqual(len(history_candidates(hints, limit=1)), 1)
        self.assertEqual(history_candidates(list(reversed(hints)), limit=10), out)


class SeedCatalogTests(unittest.TestCase):
    def test_repository_seed_catalog_is_valid_and_unique(self):
        seeds = load_seed_catalog()
        self.assertGreaterEqual(len(seeds), 20)
        keys = [s["company_key"] for s in seeds]
        idents = [(s["ats_provider"], s["ats_org_id"].lower()) for s in seeds]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(len(idents), len(set(idents)))
        self.assertTrue(all(s["discovery_source"] == "seed_catalog" for s in seeds))
        self.assertTrue(all(s["careers_url"].startswith("https://") for s in seeds))
        # Migration 010 already registers these; catalog must not duplicate them.
        for existing in ("stripe", "notion", "netflix", "figma", "airbnb", "datadog",
                         "cloudflare", "ramp", "openai", "shopify"):
            self.assertNotIn(existing, keys)

    def test_invalid_entries_are_dropped(self):
        data = {"catalog_version": "t", "companies": [
            {"company_key": "ok", "company_name": "Ok", "ats_provider": "greenhouse", "ats_org_id": "ok"},
            {"company_key": "Bad Key", "company_name": "B", "ats_provider": "greenhouse", "ats_org_id": "b"},
            {"company_key": "x", "company_name": "X", "ats_provider": "company_careers", "ats_org_id": "x"},
            {"company_key": "y", "company_name": "Y", "ats_provider": "ashby", "ats_org_id": "../etc"},
            {"company_key": "dup", "company_name": "Dup", "ats_provider": "greenhouse", "ats_org_id": "OK"},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "seeds.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            seeds = load_seed_catalog(path)
        self.assertEqual([s["company_key"] for s in seeds], ["ok"])


def _client(handler) -> SafeHttpClient:
    return SafeHttpClient(transport=httpx.MockTransport(handler), max_retries=0)


class VerifyTests(unittest.TestCase):
    def test_verified_with_job_count(self):
        client = _client(lambda req: httpx.Response(200, json={"jobs": [
            {"id": 1, "title": "Engineer", "absolute_url": "https://boards.greenhouse.io/acme/jobs/1",
             "location": {"name": "Remote"}, "updated_at": "2026-09-01T00:00:00Z"},
        ]}))
        result = verify_candidate(
            {"ats_provider": "greenhouse", "ats_org_id": "acme", "company_key": "acme",
             "company_name": "Acme"},
            client,
        )
        self.assertEqual((result.outcome, result.job_count), ("verified", 1))

    def test_not_found_is_rejected_and_server_error_retries(self):
        missing = verify_candidate(
            {"ats_provider": "ashby", "ats_org_id": "nope", "company_key": "nope", "company_name": "N"},
            _client(lambda req: httpx.Response(404)),
        )
        self.assertEqual((missing.outcome, missing.error_category), ("rejected", "not_found"))
        flaky = verify_candidate(
            {"ats_provider": "ashby", "ats_org_id": "x", "company_key": "x", "company_name": "X"},
            _client(lambda req: httpx.Response(503)),
        )
        self.assertEqual((flaky.outcome, flaky.error_category), ("failed", "server_error"))

    def test_unsupported_provider_rejected_without_network(self):
        def boom(req):
            raise AssertionError("network must not be called")

        result = verify_candidate(
            {"ats_provider": "company_careers", "careers_url": "https://example.com"}, _client(boom)
        )
        self.assertEqual(result.outcome, "rejected")


class FakeExpansionStore:
    def __init__(self, claim: list[dict[str, Any]] | None = None):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.claim = claim or []

    async def upsert_discovery_company_candidates(self, payload):
        self.calls.append(("upsert", payload))
        return {"inserted_count": len(payload["candidates"])}

    async def list_discovery_posting_url_hints(self, payload=None):
        self.calls.append(("hints", payload or {}))
        return {"hints": [{"url": "https://boards.greenhouse.io/acme/jobs/9", "company": "Acme"}]}

    async def claim_discovery_company_candidates(self, payload):
        self.calls.append(("claim", payload))
        return {"candidates": self.claim[: payload["limit"]]}

    async def record_discovery_company_verification(self, payload):
        self.calls.append(("record", payload))
        return {"ok": True, "promoted": payload["outcome"] == "verified"}


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_verification_and_recording(self):
        claim = [
            {"id": f"00000000-0000-4000-8000-00000000000{i}", "company_key": f"c{i}",
             "company_name": f"C{i}", "ats_provider": "greenhouse", "ats_org_id": f"c{i}"}
            for i in range(4)
        ]
        store = FakeExpansionStore(claim)

        def handler(req: httpx.Request) -> httpx.Response:
            if "/c1/" in req.url.path:
                return httpx.Response(404)
            return httpx.Response(200, json={"jobs": []})

        worker = CompanyExpansionWorker(
            store,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_verifications_per_run=3),
            http=_client(handler),
        )
        summary = await worker.run()
        claim_call = [p for n, p in store.calls if n == "claim"][0]
        self.assertEqual(claim_call["limit"], 3)
        records = [p for n, p in store.calls if n == "record"]
        self.assertEqual([r["outcome"] for r in records], ["verified", "rejected", "verified"])
        self.assertEqual((summary.verified, summary.promoted, summary.rejected), (2, 2, 1))
        upserts = [p for n, p in store.calls if n == "upsert"]
        self.assertEqual(upserts[-1]["candidates"][0]["discovery_source"], "posting_history")
        self.assertGreater(summary.seeds_offered, 0)

    async def test_zero_verifications_skips_claim(self):
        store = FakeExpansionStore()
        summary = await CompanyExpansionWorker(
            store,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_verifications_per_run=0),
        ).run(include_seeds=False, include_history=False)
        self.assertEqual(store.calls, [])
        self.assertEqual(summary.claimed, 0)


if __name__ == "__main__":
    unittest.main()
