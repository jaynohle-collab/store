"""Provider outage must not block bounded company discovery.

Network-isolated: fake stores/adapters/providers only; never Auth0, Vercel MCP or Neon.
"""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    FallbackEvaluationProvider,
    QuotaExhaustedError,
    TransientProviderError,
)
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
from job_agent.auto_discovery.types import LightweightCandidate
from job_agent.lifecycle.url import normalize_url
from job_agent.memory.fingerprint import compute_description_hash
from job_agent.tests.test_auto_discovery_provider_fallback import SeqProvider
from job_agent.tests.test_auto_discovery_ranking import (
    CountingAdapter,
    StateStore,
    listings,
)

# FakeAdapter.get_job fills this description for listings without one.
FULL_DESCRIPTION = "Build production LLM agents, MCP, and backend platforms."


class DownProvider:
    name = "fallback"

    def __init__(self) -> None:
        self.calls = 0

    def complete_json(self, *, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        raise AllProvidersUnavailableError(
            "all LLM providers unavailable: gemini:HTTP 429 RESOURCE_EXHAUSTED; "
            "openai:HTTP 429 credit_balance_exhausted"
        )


def pending_row(n: int = 900) -> dict[str, Any]:
    description = "Build agent infrastructure and LLM evaluation platforms."
    return {
        "id": f"pending-{n}",
        "client_candidate_id": f"greenhouse:acme:{n}",
        "company": "Acme",
        "title": "Staff AI Engineer",
        "url": f"https://boards.greenhouse.io/acme/jobs/{n}",
        "source": "greenhouse",
        "external_job_id": str(n),
        "location": "Remote - US",
        "posted_date": "2026-09-20",
        "description": description,
        "description_hash": compute_description_hash(description) or "",
    }


def claim(key: str, n: int) -> dict[str, Any]:
    return {
        "company": {
            "id": f"co-{n}",
            "company_key": key,
            "company_name": key.title(),
            "ats_provider": "greenhouse",
            "ats_org_id": key,
        },
        "run": {"id": f"crun-{n}"},
    }


class OutageStore(StateStore):
    def __init__(self, companies: list[str] | None = None) -> None:
        super().__init__()
        self._pending_items = [pending_row()]
        self.companies = companies or ["acme"]

    async def claim_due_discovery_companies(self, payload=None):
        self.calls.append(("claim_due_discovery_companies", dict(payload or {})))
        claims = [claim(key, i + 1) for i, key in enumerate(self.companies)]
        claims = claims[: int((payload or {}).get("limit") or len(claims))]
        return {"claimed_count": len(claims), "claims": claims}


def limits(**overrides: Any) -> DiscoveryLimits:
    base = dict(
        max_companies=1,
        max_listings_per_company=100,
        top_candidates_per_company=3,
        max_evals_per_run=10,
        max_batches_per_run=3,
        max_jobs_per_batch=5,
    )
    base.update(overrides)
    return DiscoveryLimits(**base)


class ProviderOutageControlFlowTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, store, adapter, provider, **limit_overrides):
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter", return_value=adapter
        ):
            metrics = await AutomaticDiscoveryPipeline(
                store, provider=provider, limits=limits(**limit_overrides)  # type: ignore[arg-type]
            ).run()
        finish = [p for n, p in store.calls if n == "finish_automatic_discovery_run"][0]
        return metrics, finish

    @staticmethod
    def _names(store) -> list[str]:
        return [n for n, _ in store.calls]

    @staticmethod
    def _preserved(store) -> list[dict[str, Any]]:
        return [
            item
            for n, p in store.calls
            if n == "preserve_pending_discovery_evaluations"
            for item in p["items"]
        ]

    async def test_pending_outage_still_scans_due_company_and_queues_selected(self):
        store = OutageStore()
        adapter = CountingAdapter(listings(10))
        provider = DownProvider()

        metrics, finish = await self._run(store, adapter, provider)

        # Pending resume hit the outage, but a due company was still scanned.
        self.assertIn("claim_due_discovery_companies", self._names(store))
        self.assertEqual(metrics.pending_claimed, 1)
        self.assertEqual(metrics.pending_paused, 1)
        self.assertEqual(metrics.companies_claimed, 1)
        self.assertEqual(metrics.candidates_listed, 10)
        self.assertEqual(metrics.candidates_selected, 3)
        self.assertEqual(len(adapter.fetched), 3)
        # Circuit breaker: exactly one provider attempt for the whole run.
        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertTrue(metrics.provider_circuit_open)
        # Selected candidates are durably queued against their company.
        self.assertEqual(metrics.candidates_queued, 3)
        self.assertEqual(metrics.evaluations_paused, 4)
        queued = [i for i in self._preserved(store) if i["company_key"] == "acme"]
        self.assertEqual(len(queued), 3)
        # The claimed pending row is not re-preserved (it already holds the work).
        self.assertEqual(len(self._preserved(store)), 3)
        self.assertEqual(finish["metrics"]["pending_preserved"], 3)
        self.assertTrue(all(i["description"] and i["description_hash"] for i in queued))
        # Company completes normally: not failed, not deferred (rotation continues).
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.companies_deferred, 0)
        self.assertNotIn("fail_discovery_company_run", self._names(store))
        completes = [p for n, p in store.calls if n == "complete_discovery_company_run"]
        self.assertEqual(len(completes), 1)
        self.assertTrue(completes[0]["success"])
        self.assertFalse(completes[0].get("deferred", False))
        self.assertEqual(completes[0]["metrics"]["candidates_queued"], 3)
        self.assertEqual(
            completes[0]["metrics"]["evaluation_paused_reason"], "llm_unavailable"
        )
        # No evidence invented, nothing submitted, pending row not completed.
        self.assertNotIn("record_discovery_evaluations", self._names(store))
        self.assertNotIn("submit_discovery_batch", self._names(store))
        self.assertNotIn("complete_pending_discovery_evaluation", self._names(store))
        # Run stays partial with a stable paused reason and separate metrics.
        self.assertEqual(finish["status"], "partial")
        self.assertEqual(finish["error_summary"], "all_providers_unavailable")
        m = finish["metrics"]
        self.assertEqual(m["paused_reason"], "all_providers_unavailable")
        self.assertTrue(m["quota_exhausted"])
        for key, value in {
            "pending_claimed": 1,
            "pending_completed": 0,
            "pending_paused": 1,
            "companies_claimed": 1,
            "listings_fetched": 10,
            "candidates_queued": 3,
            "evaluations_paused": 4,
        }.items():
            self.assertEqual(m[key], value, key)

    async def test_production_like_fallback_chain_is_attempted_once_per_run(self):
        gemini = SeqProvider(
            "gemini",
            [
                TransientProviderError("gemini HTTP 503 high demand"),
                TransientProviderError("gemini HTTP 503 high demand"),
                QuotaExhaustedError("gemini HTTP 429 RESOURCE_EXHAUSTED"),
            ],
        )
        openai = SeqProvider(
            "openai", [QuotaExhaustedError("openai HTTP 429 credit_balance_exhausted")]
        )
        chain = FallbackEvaluationProvider([gemini, openai])  # type: ignore[list-item]
        store = OutageStore(companies=["acme", "globex"])

        metrics, finish = await self._run(
            store, CountingAdapter(listings(10)), chain, max_companies=2
        )

        self.assertEqual(gemini.calls, 1)
        self.assertEqual(openai.calls, 1)
        self.assertEqual(metrics.companies_claimed, 2)
        self.assertEqual(metrics.companies_completed, 2)
        self.assertEqual(metrics.candidates_listed, 20)
        self.assertEqual(metrics.candidates_queued, 6)
        self.assertEqual(finish["metrics"]["paused_reason"], "all_providers_unavailable")

    async def test_single_provider_transient_outage_opens_circuit_not_abandon(self):
        # resolve_provider returns a lone provider unwrapped; its 503 must count
        # as an outage, never as invalid model output.
        gemini = SeqProvider(
            "gemini", [TransientProviderError("gemini HTTP 503 high demand")] * 20
        )
        store = OutageStore()

        metrics, finish = await self._run(store, CountingAdapter(listings(10)), gemini)

        self.assertEqual(gemini.calls, 1)
        self.assertTrue(metrics.provider_circuit_open)
        self.assertEqual(metrics.candidates_rejected, 0)
        self.assertEqual(metrics.candidates_queued, 3)
        self.assertEqual(metrics.pending_paused, 1)
        self.assertNotIn("complete_pending_discovery_evaluation", self._names(store))
        self.assertEqual(finish["status"], "partial")
        self.assertEqual(finish["metrics"]["paused_reason"], "all_providers_unavailable")

    async def test_queue_growth_is_bounded_by_top_k_and_company_limit(self):
        store = OutageStore(companies=["acme", "globex", "initech"])
        metrics, _ = await self._run(
            store,
            CountingAdapter(listings(10)),
            DownProvider(),
            max_companies=2,
            top_candidates_per_company=2,
        )
        self.assertEqual(metrics.companies_claimed, 2)
        by_company: dict[str, int] = {}
        for item in self._preserved(store):
            if item["company_key"]:
                by_company[item["company_key"]] = by_company.get(item["company_key"], 0) + 1
        self.assertEqual(by_company, {"acme": 2, "globex": 2})
        self.assertEqual(metrics.candidates_queued, 4)

    async def test_circuit_open_reuses_stored_evidence_without_llm(self):
        store = OutageStore()
        top = listings(1)[0]
        full = LightweightCandidate(
            client_candidate_id=top.client_candidate_id,
            company=top.company,
            title=top.title,
            url=top.url,
            source=top.source,
            external_job_id=top.external_job_id,
            location=top.location,
            posted_date=top.posted_date,
            description=FULL_DESCRIPTION,
            description_hash=compute_description_hash(FULL_DESCRIPTION) or "",
        )
        client_id = AutomaticDiscoveryPipeline(store)._idempotent_client_id(full)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-stored-q",
            "client_evaluation_id": client_id,
            "url": full.url,
            "normalized_url": normalize_url(full.url),
            "source": full.source,
            "external_job_id": full.external_job_id,
            "description_hash": full.description_hash,
            "gpt_relevance_score": 88,
            "gpt_decision": "QUALIFIED",
            "reasoning_summary": "Prior evaluation",
            "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "normalization_version": "fingerprint-v1",
            "posting_status": "OPEN",
        }
        provider = DownProvider()

        metrics, _ = await self._run(store, CountingAdapter([top]), provider)

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.stored_reused, 1)
        self.assertEqual(metrics.candidates_queued, 0)
        self.assertEqual(metrics.batches_submitted, 1)
        submit = [p for n, p in store.calls if n == "submit_discovery_batch"][0]
        attachment = submit["jobs"][0]["gpt_evaluation"]
        self.assertEqual(attachment["evaluation_id"], "eval-stored-q")
        self.assertEqual(attachment["evaluation_version"], "gpt-fit-v2")

    async def test_unpreservable_candidates_defer_company_instead_of_failing(self):
        class NoPreserveStore(OutageStore):
            @property
            def preserve_pending_discovery_evaluations(self):  # type: ignore[override]
                raise AttributeError("preserve unsupported")

        store = NoPreserveStore()
        metrics, finish = await self._run(
            store, CountingAdapter(listings(10)), DownProvider()
        )
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.companies_deferred, 1)
        completes = [p for n, p in store.calls if n == "complete_discovery_company_run"]
        self.assertTrue(completes[0]["deferred"])
        self.assertEqual(completes[0]["metrics"]["deferred_reason"], "llm_unavailable")
        self.assertEqual(finish["status"], "partial")


if __name__ == "__main__":
    unittest.main()
