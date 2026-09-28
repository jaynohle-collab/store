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
from job_agent.lifecycle.url import normalize_url
from job_agent.memory.fingerprint import compute_description_hash


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
        self._evaluations_by_client_id: dict[str, dict[str, Any]] = {}
        self._pending_items: list[dict[str, Any]] = []
        self._complete_pending_fail_once = False
        self._record_conflict = False
        self._claim_companies = True
        # Simulate a lookup-create race: first lookup misses a row that exists.
        self._hide_lookup_once = False

    async def start_automatic_discovery_run(self, payload=None):
        self.calls.append(("start_automatic_discovery_run", dict(payload or {})))
        return {"id": "run-1"}

    async def finish_automatic_discovery_run(self, payload):
        self.calls.append(("finish_automatic_discovery_run", dict(payload)))
        return {"id": payload["run_id"]}

    async def claim_due_discovery_companies(self, payload=None):
        self.calls.append(("claim_due_discovery_companies", dict(payload or {})))
        if not self._claim_companies:
            return {"claimed_count": 0, "claims": []}
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

    async def get_discovery_evaluation_by_client_id(self, payload):
        self.calls.append(("get_discovery_evaluation_by_client_id", dict(payload)))
        client_id = str(payload.get("client_evaluation_id") or "")
        if self._hide_lookup_once:
            self._hide_lookup_once = False
            return {"ok": True, "found": False, "evaluation": None}
        stored = self._evaluations_by_client_id.get(client_id)
        return {"ok": True, "found": stored is not None, "evaluation": stored}

    async def record_discovery_evaluations(self, payload):
        self.calls.append(("record_discovery_evaluations", dict(payload)))
        out = []
        for ev in payload.get("evaluations") or []:
            client_id = str(ev.get("client_evaluation_id") or "")
            existing = self._evaluations_by_client_id.get(client_id)
            if existing is not None:
                if self._record_conflict or existing.get("gpt_decision") != ev.get(
                    "gpt_decision"
                ):
                    raise RuntimeError(
                        f"client_evaluation_id {client_id} already exists with a "
                        "different evaluation payload"
                    )
                out.append(
                    {
                        "evaluation_id": existing["evaluation_id"],
                        "client_evaluation_id": client_id,
                        "gpt_decision": existing.get("gpt_decision"),
                    }
                )
                continue
            eid = f"eval-{len(self._eval_ids) + 1}"
            self._eval_ids.append(client_id)
            stored = {
                "evaluation_id": eid,
                "client_evaluation_id": client_id,
                "client_candidate_id": ev.get("client_candidate_id"),
                "company": ev.get("company"),
                "title": ev.get("title"),
                "url": ev.get("url"),
                "normalized_url": normalize_url(str(ev.get("url") or "")),
                "source": ev.get("source"),
                "external_job_id": ev.get("external_job_id") or "",
                "description_hash": ev.get("description_hash") or "",
                "gpt_relevance_score": ev.get("gpt_relevance_score"),
                "gpt_decision": ev.get("gpt_decision"),
                "reasoning_summary": ev.get("reasoning_summary"),
                "evaluation_version": ev.get("evaluation_version"),
                "remote_scope": ev.get("remote_scope"),
                "direct_posting_url_verified": ev.get("direct_posting_url_verified"),
                "normalization_version": ev.get("normalization_version"),
                "posting_status": ev.get("posting_status"),
                "hard_rejection_reason": ev.get("hard_rejection_reason"),
            }
            self._evaluations_by_client_id[client_id] = stored
            out.append(
                {
                    "evaluation_id": eid,
                    "client_evaluation_id": client_id,
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
        items = list(self._pending_items)
        self._pending_items = []
        return {"ok": True, "claimed_count": len(items), "items": items}

    async def complete_pending_discovery_evaluation(self, payload):
        self.calls.append(("complete_pending_discovery_evaluation", dict(payload)))
        if self._complete_pending_fail_once:
            self._complete_pending_fail_once = False
            raise RuntimeError("simulated crash after evaluation persistence")
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

    async def test_max_evals_reached_defers_without_company_failure(self):
        store = FakeStore()
        provider = FakeProvider("ok")
        second = LightweightCandidate(
            client_candidate_id="greenhouse:stripe:1003",
            company="Stripe",
            title="Senior Platform Engineer",
            url="https://boards.greenhouse.io/stripe/jobs/1003",
            source="greenhouse",
            external_job_id="1003",
            location="Remote - United States",
            description="Build production LLM agents and platforms.",
        )
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(
                max_companies=1,
                max_candidates_per_company=10,
                max_evals_per_run=1,
                max_batches_per_run=2,
                max_jobs_per_batch=10,
            ),
        )
        adapter = FakeAdapter([self.open_cand, second])
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=adapter,
        ):
            metrics = await pipeline.run()

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 1)
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.companies_completed, 1)
        finish = [p for n, p in store.calls if n == "finish_automatic_discovery_run"][0]
        self.assertEqual(finish["status"], "partial")
        self.assertEqual(finish["metrics"]["paused_reason"], "max_evals_reached")
        self.assertFalse(
            any(name == "fail_discovery_company_run" for name, _ in store.calls)
        )
        completes = [
            p for n, p in store.calls if n == "complete_discovery_company_run"
        ]
        self.assertEqual(len(completes), 1)
        self.assertTrue(completes[0].get("deferred"))
        self.assertEqual(
            completes[0].get("metrics", {}).get("deferred_reason"),
            "max_evals_reached",
        )
        self.assertTrue(
            any(
                name == "preserve_pending_discovery_evaluations"
                for name, _ in store.calls
            )
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

    def _pending_row(self, cand: LightweightCandidate) -> dict[str, Any]:
        description = cand.description or "Build production LLM agents and platforms."
        desc_hash = cand.description_hash or compute_description_hash(description) or ""
        return {
            "id": "pending-1",
            "client_candidate_id": cand.client_candidate_id,
            "company": cand.company,
            "title": cand.title,
            "url": cand.url,
            "source": cand.source,
            "external_job_id": cand.external_job_id,
            "location": cand.location or "",
            "posted_date": cand.posted_date or "",
            "description": description,
            "description_hash": desc_hash,
        }

    def _cand_with_hash(self, cand: LightweightCandidate) -> LightweightCandidate:
        description = cand.description or "Build production LLM agents and platforms."
        return LightweightCandidate(
            client_candidate_id=cand.client_candidate_id,
            company=cand.company,
            title=cand.title,
            url=cand.url,
            source=cand.source,
            external_job_id=cand.external_job_id,
            location=cand.location,
            posted_date=cand.posted_date,
            description=description,
            description_hash=compute_description_hash(description) or "",
        )

    async def test_pending_crash_after_persist_reuses_on_retry(self):
        """Crash after evaluation persist / before pending complete → reuse on retry."""
        store = FakeStore()
        store._claim_companies = False
        cand = self._cand_with_hash(self.open_cand)
        store._pending_items = [self._pending_row(cand)]
        store._complete_pending_fail_once = True
        provider = FakeProvider("ok")
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )

        metrics1 = await pipeline.run()
        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics1.llm_calls, 1)
        self.assertEqual(metrics1.candidates_evaluated, 1)
        self.assertTrue(
            any("simulated crash" in err for err in metrics1.errors)
        )
        self.assertEqual(len(store._evaluations_by_client_id), 1)
        client_id = next(iter(store._evaluations_by_client_id))
        # Re-queue the unfinished pending row (lease would return it).
        store._pending_items = [self._pending_row(cand)]
        store.calls.clear()
        provider2 = FakeProvider("ok")
        pipeline2 = AutomaticDiscoveryPipeline(
            store,
            provider=provider2,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        metrics = await pipeline2.run()
        self.assertEqual(provider2.calls, 0)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_qualified, 1)
        self.assertEqual(metrics.batches_submitted, 1)
        self.assertFalse(
            any(n == "record_discovery_evaluations" for n, _ in store.calls)
        )
        self.assertTrue(
            any(n == "get_discovery_evaluation_by_client_id" for n, _ in store.calls)
        )
        self.assertTrue(
            any(n == "complete_pending_discovery_evaluation" for n, _ in store.calls)
        )
        submit = [p for n, p in store.calls if n == "submit_discovery_batch"][0]
        self.assertEqual(
            submit["jobs"][0]["gpt_evaluation"]["evaluation_id"],
            store._evaluations_by_client_id[client_id]["evaluation_id"],
        )

    async def test_pending_retry_reuses_stored_rejected(self):
        store = FakeStore()
        store._claim_companies = False
        cand = self._cand_with_hash(self.open_cand)
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=FakeProvider("ok"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        client_id = pipeline._idempotent_client_id(cand)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-rej-1",
            "client_evaluation_id": client_id,
            "url": cand.url,
            "normalized_url": normalize_url(cand.url),
            "source": cand.source,
            "external_job_id": cand.external_job_id,
            "description_hash": cand.description_hash,
            "gpt_relevance_score": 40,
            "gpt_decision": "REJECTED_LOW_SCORE",
            "reasoning_summary": "Low score",
            "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "posting_status": "OPEN",
        }
        store._pending_items = [self._pending_row(cand)]
        provider = FakeProvider("ok")
        pipeline.provider = provider  # type: ignore[attr-defined]
        metrics = await pipeline.run()
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_rejected, 1)
        self.assertEqual(metrics.candidates_qualified, 0)
        self.assertEqual(metrics.batches_submitted, 0)
        self.assertTrue(
            any(n == "complete_pending_discovery_evaluation" for n, _ in store.calls)
        )

    async def test_pending_retry_reuses_stored_qualified(self):
        store = FakeStore()
        store._claim_companies = False
        cand = self._cand_with_hash(self.open_cand)
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=FakeProvider("ok"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        client_id = pipeline._idempotent_client_id(cand)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-qual-1",
            "client_evaluation_id": client_id,
            "url": cand.url,
            "normalized_url": normalize_url(cand.url),
            "source": cand.source,
            "external_job_id": cand.external_job_id,
            "description_hash": cand.description_hash,
            "gpt_relevance_score": 88,
            "gpt_decision": "QUALIFIED",
            "reasoning_summary": "Strong match",
            "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "normalization_version": "fingerprint-v1",
            "posting_status": "OPEN",
        }
        store._pending_items = [self._pending_row(cand)]
        provider = FakeProvider("ok")
        metrics = await AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        ).run()
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.candidates_qualified, 1)
        self.assertEqual(metrics.batches_submitted, 1)
        submit = [p for n, p in store.calls if n == "submit_discovery_batch"][0]
        self.assertEqual(
            submit["jobs"][0]["gpt_evaluation"]["evaluation_id"], "eval-qual-1"
        )

    async def test_pending_reuse_mismatched_identity_fails_closed(self):
        store = FakeStore()
        store._claim_companies = False
        cand = self._cand_with_hash(self.open_cand)
        pipeline = AutomaticDiscoveryPipeline(
            store,
            provider=FakeProvider("ok"),  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        )
        client_id = pipeline._idempotent_client_id(cand)
        store._evaluations_by_client_id[client_id] = {
            "evaluation_id": "eval-bad",
            "client_evaluation_id": client_id,
            "url": cand.url,
            "normalized_url": normalize_url(cand.url),
            "source": cand.source,
            "external_job_id": cand.external_job_id,
            "description_hash": "ffffffffffffffff",  # mismatch
            "gpt_relevance_score": 88,
            "gpt_decision": "QUALIFIED",
            "reasoning_summary": "Strong match",
            "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "posting_status": "OPEN",
        }
        store._pending_items = [self._pending_row(cand)]
        provider = FakeProvider("ok")
        metrics = await AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        ).run()
        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.batches_submitted, 0)
        self.assertTrue(
            any("identity mismatch" in err for err in metrics.errors)
        )
        self.assertFalse(
            any(n == "record_discovery_evaluations" for n, _ in store.calls)
        )
        self.assertFalse(
            any(n == "complete_pending_discovery_evaluation" for n, _ in store.calls)
        )

    # --- Fresh-scan evaluate-or-reuse -------------------------------------------

    def _seed_stored(
        self,
        store: FakeStore,
        cand: LightweightCandidate,
        *,
        decision: str = "REJECTED_LOW_SCORE",
        evaluation_id: str = "eval-prior",
        **overrides: Any,
    ) -> str:
        client_id = AutomaticDiscoveryPipeline(store)._idempotent_client_id(cand)
        qualified = decision == "QUALIFIED"
        stored = {
            "evaluation_id": evaluation_id,
            "client_evaluation_id": client_id,
            "client_candidate_id": cand.client_candidate_id,
            "company": cand.company,
            "title": cand.title,
            "url": cand.url,
            "normalized_url": normalize_url(cand.url),
            "source": cand.source,
            "external_job_id": cand.external_job_id,
            "description_hash": cand.description_hash,
            "gpt_relevance_score": 88 if qualified else 0,
            "gpt_decision": decision,
            "reasoning_summary": "Prior evaluation",
            "evaluation_version": "gpt-fit-v2",
            "remote_scope": "US_NATIONWIDE",
            "direct_posting_url_verified": True,
            "normalization_version": "fingerprint-v1",
            "posting_status": "OPEN",
            "hard_rejection_reason": None,
        }
        stored.update(overrides)
        store._evaluations_by_client_id[client_id] = stored
        return client_id

    async def _run_fresh_scan(
        self, store: FakeStore, candidates: list[LightweightCandidate]
    ) -> tuple[Any, FakeProvider]:
        provider = FakeProvider("ok")
        with mock.patch(
            "job_agent.auto_discovery.pipeline.get_adapter",
            return_value=FakeAdapter(candidates),
        ):
            metrics = await AutomaticDiscoveryPipeline(
                store,
                provider=provider,  # type: ignore[arg-type]
                limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
            ).run()
        return metrics, provider

    @staticmethod
    def _names(store: FakeStore) -> list[str]:
        return [n for n, _ in store.calls]

    async def test_fresh_scan_reuses_unchanged_rejected_evaluation(self):
        store = FakeStore()
        cand = self._cand_with_hash(self.open_cand)
        client_id = self._seed_stored(store, cand)
        before = dict(store._evaluations_by_client_id[client_id])

        metrics, provider = await self._run_fresh_scan(store, [cand])

        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.llm_calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_rejected, 1)
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.companies_completed, 1)
        self.assertEqual(metrics.errors, [])
        self.assertNotIn("record_discovery_evaluations", self._names(store))
        self.assertNotIn("fail_discovery_company_run", self._names(store))
        self.assertEqual(store._evaluations_by_client_id[client_id], before)
        lookups = [
            p for n, p in store.calls if n == "get_discovery_evaluation_by_client_id"
        ]
        self.assertEqual(lookups, [{"client_evaluation_id": client_id}])

    async def test_fresh_scan_mixed_reuse_and_new_counts_only_llm_work(self):
        store = FakeStore()
        reused = self._cand_with_hash(self.open_cand)
        self._seed_stored(store, reused)
        fresh = self._cand_with_hash(
            LightweightCandidate(
                client_candidate_id="greenhouse:stripe:1003",
                company="Stripe",
                title="Senior Platform Engineer",
                url="https://boards.greenhouse.io/stripe/jobs/1003",
                source="greenhouse",
                external_job_id="1003",
                location="Remote - United States",
                description="Build production LLM agents and platforms.",
            )
        )

        metrics, provider = await self._run_fresh_scan(store, [reused, fresh])

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.llm_calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 1)
        records = [p for n, p in store.calls if n == "record_discovery_evaluations"]
        self.assertEqual(len(records), 1)
        self.assertEqual(
            records[0]["evaluations"][0]["external_job_id"], fresh.external_job_id
        )

    async def test_fresh_scan_reused_qualified_follows_normal_submission(self):
        store = FakeStore()
        cand = self._cand_with_hash(self.open_cand)
        self._seed_stored(
            store, cand, decision="QUALIFIED", evaluation_id="eval-qual-fresh"
        )

        metrics, provider = await self._run_fresh_scan(store, [cand])

        self.assertEqual(provider.calls, 0)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_qualified, 1)
        self.assertEqual(metrics.batches_submitted, 1)
        self.assertNotIn("record_discovery_evaluations", self._names(store))
        submit = [p for n, p in store.calls if n == "submit_discovery_batch"][0]
        attachment = submit["jobs"][0]["gpt_evaluation"]
        self.assertEqual(attachment["evaluation_id"], "eval-qual-fresh")
        self.assertEqual(attachment["gpt_decision"], "QUALIFIED")
        self.assertEqual(attachment["evaluation_version"], "gpt-fit-v2")

    async def test_fresh_scan_identity_mismatch_fails_closed(self):
        for field, value in (
            ("description_hash", "ffffffffffffffff"),
            ("external_job_id", "9999"),
            ("source", "lever"),
            ("evaluation_version", "gpt-fit-v1"),
            ("normalized_url", "https://boards.greenhouse.io/stripe/jobs/other"),
        ):
            with self.subTest(field=field):
                store = FakeStore()
                cand = self._cand_with_hash(self.open_cand)
                client_id = self._seed_stored(store, cand, **{field: value})
                before = dict(store._evaluations_by_client_id[client_id])

                metrics, provider = await self._run_fresh_scan(store, [cand])

                self.assertEqual(provider.calls, 0)
                self.assertEqual(metrics.llm_calls, 0)
                self.assertEqual(metrics.candidates_evaluated, 0)
                self.assertEqual(metrics.companies_failed, 1)
                self.assertNotIn("record_discovery_evaluations", self._names(store))
                self.assertIn("fail_discovery_company_run", self._names(store))
                self.assertEqual(store._evaluations_by_client_id[client_id], before)
                self.assertEqual(len(metrics.errors), 1)
                err = metrics.errors[0]
                self.assertIn("identity mismatch", err)
                self.assertIn(client_id, err)
                self.assertNotIn("Prior evaluation", err)
                self.assertNotIn(cand.description or "", err)

    async def test_record_conflict_race_reuses_matching_stored_evaluation(self):
        store = FakeStore()
        cand = self._cand_with_hash(self.open_cand)
        client_id = self._seed_stored(store, cand)
        before = dict(store._evaluations_by_client_id[client_id])
        store._hide_lookup_once = True
        store._record_conflict = True

        metrics, provider = await self._run_fresh_scan(store, [cand])

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.llm_calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_rejected, 1)
        self.assertEqual(metrics.companies_failed, 0)
        self.assertEqual(metrics.errors, [])
        names = self._names(store)
        self.assertEqual(names.count("record_discovery_evaluations"), 1)
        self.assertEqual(names.count("get_discovery_evaluation_by_client_id"), 2)
        self.assertEqual(store._evaluations_by_client_id[client_id], before)

    async def test_record_conflict_race_with_mismatching_evidence_stays_error(self):
        store = FakeStore()
        cand = self._cand_with_hash(self.open_cand)
        client_id = self._seed_stored(
            store, cand, description_hash="ffffffffffffffff"
        )
        before = dict(store._evaluations_by_client_id[client_id])
        store._hide_lookup_once = True
        store._record_conflict = True

        metrics, provider = await self._run_fresh_scan(store, [cand])

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.llm_calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_qualified, 0)
        self.assertEqual(metrics.batches_submitted, 0)
        self.assertEqual(metrics.companies_failed, 1)
        self.assertTrue(
            any("different evaluation payload" in err for err in metrics.errors)
        )
        self.assertEqual(store._evaluations_by_client_id[client_id], before)

    async def test_non_conflict_record_error_is_not_masked_by_lookup(self):
        store = FakeStore()
        cand = self._cand_with_hash(self.open_cand)

        async def boom(payload):
            store.calls.append(("record_discovery_evaluations", dict(payload)))
            raise RuntimeError("Remote MCP call failed: HTTP 500")

        store.record_discovery_evaluations = boom  # type: ignore[method-assign]
        metrics, provider = await self._run_fresh_scan(store, [cand])

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.companies_failed, 1)
        self.assertTrue(any("HTTP 500" in err for err in metrics.errors))
        self.assertEqual(
            self._names(store).count("get_discovery_evaluation_by_client_id"), 1
        )

    async def test_pending_record_conflict_race_reuses_and_completes_pending(self):
        store = FakeStore()
        store._claim_companies = False
        cand = self._cand_with_hash(self.open_cand)
        self._seed_stored(store, cand)
        store._pending_items = [self._pending_row(cand)]
        store._hide_lookup_once = True
        store._record_conflict = True
        provider = FakeProvider("ok")

        metrics = await AutomaticDiscoveryPipeline(
            store,
            provider=provider,  # type: ignore[arg-type]
            limits=DiscoveryLimits(max_companies=1, max_evals_per_run=5),
        ).run()

        self.assertEqual(provider.calls, 1)
        self.assertEqual(metrics.candidates_evaluated, 0)
        self.assertEqual(metrics.candidates_rejected, 1)
        self.assertEqual(metrics.errors, [])
        completes = [
            p for n, p in store.calls if n == "complete_pending_discovery_evaluation"
        ]
        self.assertEqual(len(completes), 1)
        self.assertEqual(completes[0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()