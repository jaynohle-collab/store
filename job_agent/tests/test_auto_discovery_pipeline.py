"""Network-isolated automatic discovery pipeline tests (Milestone 5)."""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

from job_agent.auto_discovery.deterministic import deterministic_reject_reason
from job_agent.auto_discovery.evaluate.gpt_fit_v2 import InvalidModelOutputError
from job_agent.auto_discovery.evaluate.providers import QuotaExhaustedError
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
from job_agent.auto_discovery.types import LightweightCandidate


class FakeProvider:
    name = "fake"

    def __init__(self, mode: str = "ok"):
        self.mode = mode
        self.calls = 0

    def complete_json(self, *, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        if self.mode == "quota":
            raise QuotaExhaustedError("quota")
        if self.mode == "invalid":
            raise InvalidModelOutputError("bad json")
        return {
            "gpt_relevance_score": 85,
            "gpt_decision": "QUALIFIED",
            "reasoning_summary": "Strong AI platform match",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "posting_status": "OPEN",
            "hard_rejection_reason": None,
        }


class FakeAdapter:
    provider = "greenhouse"

    def __init__(self, candidates: list[LightweightCandidate]):
        self.candidates = candidates

    def list_jobs(self, company):
        return list(self.candidates)

    def get_job(self, company, candidate):
        if candidate.description:
            return candidate
        return LightweightCandidate(
            client_candidate_id=candidate.client_candidate_id,
            company=candidate.company,
            title=candidate.title,
            url=candidate.url,
            source=candidate.source,
            external_job_id=candidate.external_job_id,
            location=candidate.location,
            posted_date=candidate.posted_date,
            description="Build production LLM agents, MCP, and backend platforms.",
        )


class FakeStore:
    def __init__(self):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.submitted = 0
        self._eval_ids: list[str] = []

    async def start_automatic_discovery_run(self, payload=None):
        self.calls.append(("start_automatic_discovery_run", dict(payload or {})))
        return {"id": "run-1"}

    async def finish_automatic_discovery_run(self, payload):
        self.calls.append(("finish_automatic_discovery_run", dict(payload)))
        return {"id": payload["run_id"]}

    async def claim_due_discovery_companies(self, payload=None):
        self.calls.append(("claim_due_discovery_companies", dict(payload or {})))
        return {
            "claimed_count": 1,
            "claims": [
                {
                    "company": {
                        "id": "co-1",
                        "company_key": "stripe",
                        "company_name": "Stripe",
                        "ats_provider": "greenhouse",
                        "ats_org_id": "stripe",
                    },
                    "run": {"id": "crun-1"},
                }
            ],
        }

    async def check_discovery_candidates(self, payload):
        self.calls.append(("check_discovery_candidates", dict(payload)))
        return {
            "results": [
                {
                    "client_candidate_id": c.get("client_candidate_id"),
                    "url": c.get("url"),
                    "gpt_skip_allowed": False,
                    "gpt_reuse_allowed": False,
                }
                for c in payload.get("candidates") or []
            ]
        }

    async def record_discovery_evaluations(self, payload):
        self.calls.append(("record_discovery_evaluations", dict(payload)))
        out = []
        for ev in payload.get("evaluations") or []:
            eid = f"eval-{len(self._eval_ids) + 1}"
            self._eval_ids.append(str(ev.get("client_evaluation_id")))
            out.append(
                {
                    "evaluation_id": eid,
                    "client_evaluation_id": ev.get("client_evaluation_id"),
                    "gpt_decision": ev.get("gpt_decision"),
                }
            )
        return {"ok": True, "evaluations": out}

    async def submit_discovery_batch(self, payload):
        self.calls.append(("submit_discovery_batch", dict(payload)))
        self.submitted += 1
        return {"id": f"batch-{self.submitted}"}

    async def complete_discovery_company_run(self, payload):
        self.calls.append(("complete_discovery_company_run", dict(payload)))
        return {"ok": True}

    async def fail_discovery_company_run(self, payload):
        self.calls.append(("fail_discovery_company_run", dict(payload)))
        return {"ok": True}

    async def preserve_pending_discovery_evaluations(self, payload):
        self.calls.append(("preserve_pending_discovery_evaluations", dict(payload)))
        return {"ok": True, "saved_count": len(payload.get("items") or [])}

    async def claim_pending_discovery_evaluations(self, payload=None):
        self.calls.append(("claim_pending_discovery_evaluations", dict(payload or {})))
        return {"ok": True, "claimed_count": 0, "items": []}

    async def complete_pending_discovery_evaluation(self, payload):
        self.calls.append(("complete_pending_discovery_evaluation", dict(payload)))
        return {"ok": True}


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.open_cand = LightweightCandidate(
            client_candidate_id="greenhouse:stripe:1001",
            company="Stripe",
            title="Staff Platform Engineer",
            url="https://boards.greenhouse.io/stripe/jobs/1001",
            source="greenhouse",
            external_job_id="1001",
            location="Remote - United States",
            description="Build production LLM agents and platforms.",
        )
        self.closed_cand = LightweightCandidate(
            client_candidate_id="greenhouse:stripe:1002",
            company="Stripe",
            title="Closed Role - Filled",
            url="https://boards.greenhouse.io/stripe/jobs/1002",
            source="greenhouse",
            external_job_id="1002",
            description="Filled.",
        )

    async def test_deterministic_reject_skips_llm(self):
        self.assertIsNotNone(deterministic_reject_reason(self.closed_cand))
        store = FakeStore()
        provider = FakeProvider("ok")
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(
                max_companies=1,
                max_candidates_per_company=10,
                max_evals_per_run=10,
                max_batches_per_run=2,
                max_jobs_per_batch=10,
            ),
        )
        adapter = FakeAdapter([self.closed_cand])
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=adapter,
        ):
            metrics = await pipeline.run()
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.candidates_deterministic_rejected, 1)
        self.assertEqual(metrics.batches_submitted, 0)
        self.assertFalse(
            any(name == "submit_discovery_batch" for name, _ in store.calls)
        )

    async def test_quota_exhaustion_pauses_and_fails_company_run(self):
        store = FakeStore()
        provider = FakeProvider("quota")
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        adapter = FakeAdapter([self.open_cand])
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=adapter,
        ):
            metrics = await pipeline.run()
        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.batches_submitted, 0)
        finish = [p for n, p in store.calls if n == "finish_automatic_discovery_run"][0]
        self.assertEqual(finish["status"], "partial")
        self.assertTrue(finish["metrics"]["quota_exhausted"])
        self.assertTrue(
            any(name == "fail_discovery_company_run" for name, _ in store.calls)
        )
        self.assertFalse(
            any(name == "complete_discovery_company_run" for name, _ in store.calls)
        )

    async def test_qualified_submit_includes_gpt_evaluation_attachment(self):
        store = FakeStore()
        provider = FakeProvider("ok")
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(
                max_companies=1,
                max_candidates_per_company=10,
                max_evals_per_run=10,
                max_batches_per_run=2,
                max_jobs_per_batch=10,
            ),
        )
        adapter = FakeAdapter([self.open_cand])
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=adapter,
        ):
            metrics = await pipeline.run()
        self.assertEqual(metrics.batches_submitted, 1)
        submit = [p for n, p in store.calls if n == "submit_discovery_batch"][0]
        job = submit["jobs"][0]
        self.assertNotIn("external_id", job)
        self.assertNotIn("client_candidate_id", job)
        self.assertNotIn("description_hash", job)
        attachment = job["gpt_evaluation"]
        self.assertEqual(attachment["gpt_decision"], "QUALIFIED")
        self.assertEqual(attachment["evaluation_version"], "gpt-fit-v2")
        self.assertTrue(attachment["evaluation_id"])
        self.assertGreaterEqual(attachment["gpt_relevance_score"], 70)

    async def test_idempotent_client_ids(self):
        store = FakeStore()
        provider = FakeProvider("ok")
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        with_hash = LightweightCandidate(
            client_candidate_id=self.open_cand.client_candidate_id,
            company=self.open_cand.company,
            title=self.open_cand.title,
            url=self.open_cand.url,
            source=self.open_cand.source,
            external_job_id=self.open_cand.external_job_id,
            location=self.open_cand.location,
            description=self.open_cand.description,
            description_hash="abcdef0123456789",
        )
        a = pipeline._idempotent_client_id(with_hash)
        b = pipeline._idempotent_client_id(with_hash)
        self.assertEqual(a, b)

        adapter = FakeAdapter([self.open_cand])
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=adapter,
        ):
            await pipeline.run()
        eval_calls = [p for n, p in store.calls if n == "record_discovery_evaluations"]
        self.assertEqual(len(eval_calls), 1)
        recorded_id = eval_calls[0]["evaluations"][0]["client_evaluation_id"]
        # Same posting identity + computed hash should be stable across a second run.
        store2 = FakeStore()
        pipeline2 = AutomaticDiscoveryPipeline(
            store2,
            provider=FakeProvider("ok"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=FakeAdapter([self.open_cand]),
        ):
            await pipeline2.run()
        recorded_id2 = [
            p for n, p in store2.calls if n == "record_discovery_evaluations"
        ][0]["evaluations"][0]["client_evaluation_id"]
        self.assertEqual(recorded_id, recorded_id2)


if __name__ == "__main__":
    unittest.main()
