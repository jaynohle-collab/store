"""Provider fallback + durable pending evaluation regression tests."""

from __future__ import annotations

import os
import unittest
from typing import Any
from unittest import mock

from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    FallbackEvaluationProvider,
    QuotaExhaustedError,
    TransientProviderError,
    configured_providers,
    resolve_provider,
)
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
from job_agent.auto_discovery.types import LightweightCandidate
from job_agent.tests.test_auto_discovery_pipeline import (
    FakeAdapter,
    FakeProvider,
    FakeStore,
)


class SeqProvider:
    """Provider that fails N times then succeeds (or always fails)."""

    def __init__(self, name: str, failures: list[Exception], success: dict | None = None):
        self.name = name
        self.failures = list(failures)
        self.success = success
        self.calls = 0

    def complete_json(self, *, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        if self.success is None:
            raise QuotaExhaustedError(f"{self.name} exhausted")
        return dict(self.success)


OK_PAYLOAD = {
    "gpt_relevance_score": 85,
    "gpt_decision": "QUALIFIED",
    "reasoning_summary": "Strong AI platform match",
    "remote_scope": "US_NATIONWIDE",
    "direct_posting_url_verified": True,
    "posting_status": "OPEN",
    "hard_rejection_reason": None,
}


class ProviderFallbackTests(unittest.TestCase):
    def test_resolve_provider_is_first_key_only_without_fallback_chain_when_single(self):
        with mock.patch.dict(
            os.environ,
            {"GEMINI_API_KEY": "g", "GROQ_API_KEY": "", "OPENAI_API_KEY": ""},
            clear=False,
        ):
            # Clear empty-ish keys
            os.environ.pop("GROQ_API_KEY", None)
            os.environ.pop("OPENAI_API_KEY", None)
            os.environ["GEMINI_API_KEY"] = "g-key"
            provider = resolve_provider()
            self.assertEqual(provider.name, "gemini")
            self.assertNotIsInstance(provider, FallbackEvaluationProvider)

    def test_resolve_provider_builds_runtime_fallback_chain(self):
        with mock.patch.dict(
            os.environ,
            {
                "GEMINI_API_KEY": "g-key",
                "GROQ_API_KEY": "q-key",
                "OPENAI_API_KEY": "o-key",
                "AUTO_DISCOVERY_LLM_PROVIDER": "",
            },
            clear=False,
        ):
            os.environ.pop("AUTO_DISCOVERY_LLM_PROVIDER", None)
            provider = resolve_provider()
            self.assertIsInstance(provider, FallbackEvaluationProvider)
            assert isinstance(provider, FallbackEvaluationProvider)
            self.assertEqual(provider.provider_names, ["gemini", "groq", "openai"])

    def test_fallback_tries_next_on_quota_then_succeeds(self):
        first = SeqProvider("gemini", [QuotaExhaustedError("gemini 429")])
        second = SeqProvider("groq", [], success=OK_PAYLOAD)
        chain = FallbackEvaluationProvider([first, second])  # type: ignore[list-item]
        out = chain.complete_json(system="s", user="u", schema={})
        self.assertEqual(out["gpt_decision"], "QUALIFIED")
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)
        self.assertEqual(chain.name, "groq")

    def test_fallback_tries_next_on_transient_then_all_fail(self):
        first = SeqProvider("gemini", [TransientProviderError("503")])
        second = SeqProvider("groq", [QuotaExhaustedError("429")])
        chain = FallbackEvaluationProvider([first, second])  # type: ignore[list-item]
        with self.assertRaises(AllProvidersUnavailableError):
            chain.complete_json(system="s", user="u", schema={})
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)

    def test_configured_providers_order(self):
        with mock.patch.dict(
            os.environ,
            {
                "GEMINI_API_KEY": "g",
                "GROQ_API_KEY": "q",
                "OPENAI_API_KEY": "o",
            },
            clear=False,
        ):
            names = [p.name for p in configured_providers()]
            self.assertEqual(names, ["gemini", "groq", "openai"])


class PendingPreservationPipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.cand = LightweightCandidate(
            client_candidate_id="greenhouse:stripe:1001",
            company="Stripe",
            title="Staff Platform Engineer",
            url="https://boards.greenhouse.io/stripe/jobs/1001",
            source="greenhouse",
            external_job_id="1001",
            location="Remote - United States",
            description="Build production LLM agents and platforms.",
        )

    async def test_all_providers_down_preserves_and_resumes_without_duplicate_eval(self):
        store = FakeStore()
        store.pending: list[dict[str, Any]] = []  # type: ignore[attr-defined]

        async def preserve(payload):
            store.calls.append(("preserve_pending_discovery_evaluations", dict(payload)))
            for item in payload.get("items") or []:
                store.pending.append({**item, "id": f"pend-{len(store.pending)+1}", "status": "pending"})
            return {"ok": True, "saved_count": len(payload.get("items") or [])}

        async def claim_pending(payload=None):
            store.calls.append(("claim_pending_discovery_evaluations", dict(payload or {})))
            out = []
            for row in list(store.pending):
                if row.get("status") == "pending":
                    row["status"] = "in_progress"
                    out.append(dict(row))
            return {"ok": True, "claimed_count": len(out), "items": out}

        async def complete_pending(payload):
            store.calls.append(("complete_pending_discovery_evaluation", dict(payload)))
            for row in store.pending:
                if row.get("id") == payload.get("id"):
                    row["status"] = payload.get("status") or "completed"
            return {"ok": True}

        store.preserve_pending_discovery_evaluations = preserve  # type: ignore[method-assign]
        store.claim_pending_discovery_evaluations = claim_pending  # type: ignore[method-assign]
        store.complete_pending_discovery_evaluation = complete_pending  # type: ignore[method-assign]

        # Run 1: provider unavailable → preserve, no record/submit.
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=FakeProvider("quota"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=FakeAdapter([self.cand]),
        ):
            metrics = await pipeline.run()
        self.assertEqual(metrics.batches_submitted, 0)
        self.assertEqual(len(store.pending), 1)
        self.assertFalse(
            any(n == "record_discovery_evaluations" for n, _ in store.calls)
        )

        # Run 2: resume pending with working provider — one evaluation, one submit.
        store2 = FakeStore()
        store2.pending = store.pending  # type: ignore[attr-defined]
        store2.preserve_pending_discovery_evaluations = preserve  # type: ignore[method-assign]

        async def claim2(payload=None):
            store2.calls.append(("claim_pending_discovery_evaluations", dict(payload or {})))
            out = []
            for row in list(store2.pending):
                if row.get("status") in {"pending", "in_progress"}:
                    row["status"] = "in_progress"
                    out.append(dict(row))
            return {"ok": True, "claimed_count": len(out), "items": out}

        async def complete2(payload):
            store2.calls.append(("complete_pending_discovery_evaluation", dict(payload)))
            for row in store2.pending:
                if row.get("id") == payload.get("id"):
                    row["status"] = "completed"
            return {"ok": True}

        # No new company claims — pending resume only.
        async def claim_companies(payload=None):
            store2.calls.append(("claim_due_discovery_companies", dict(payload or {})))
            return {"claimed_count": 0, "claims": []}

        store2.claim_pending_discovery_evaluations = claim2  # type: ignore[method-assign]
        store2.complete_pending_discovery_evaluation = complete2  # type: ignore[method-assign]
        store2.claim_due_discovery_companies = claim_companies  # type: ignore[method-assign]

        pipeline2 = AutomaticDiscoveryPipeline(
            store2,
            provider=FakeProvider("ok"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        metrics2 = await pipeline2.run()
        self.assertEqual(metrics2.candidates_evaluated, 1)
        self.assertEqual(metrics2.batches_submitted, 1)
        eval_calls = [p for n, p in store2.calls if n == "record_discovery_evaluations"]
        self.assertEqual(len(eval_calls), 1)
        submit = [p for n, p in store2.calls if n == "submit_discovery_batch"][0]
        self.assertIn("gpt_evaluation", submit["jobs"][0])
        self.assertEqual(store2.pending[0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
