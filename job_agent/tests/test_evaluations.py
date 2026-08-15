"""Tests for persisted job evaluations (candidate match_score snapshots)."""

from __future__ import annotations

import unittest

from job_agent.lifecycle.evaluation_service import EvaluationService
from job_agent.lifecycle.memory_store import InMemoryLifecycleStore
from job_agent.lifecycle.process import process_discovered_job
from job_agent.lifecycle.resolver import CanonicalJobResolver
from job_agent.lifecycle.types import PostingDisposition
from job_agent.models.types import JobInput, JobSearchProfile, NormalizedJobPosting
from job_agent.memory.client import MemoryStore
from job_agent.memory.fingerprint import compute_description_hash
from job_agent.ranking.scoring import SimpleScoreCalculator
from job_agent.search.interfaces import JobNormalizer
from job_agent.workflow.engine import JobSearchWorkflow


JD = "Build production AI agent systems and LLM platforms for evaluation."


class EvaluationPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_latest_evaluation_chosen_and_history_retained(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        result = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/a",
                "source": "greenhouse",
                "external_job_id": "a",
                "description": JD,
            },
            resolver,
            match_score=18,
        )
        posting_id = str(result.job_posting["id"])
        svc = EvaluationService(store, scoring_version="v1", profile_version="p1")
        await svc.persist_evaluation(
            posting_id=posting_id,
            match_score=18,
            recommendation="save",
            reason="initial",
            evaluated_at="2026-08-15T10:00:00+00:00",
        )
        await svc.persist_evaluation(
            posting_id=posting_id,
            match_score=27,
            recommendation="save",
            reason="profile bump",
            evaluated_at="2026-08-15T12:00:00+00:00",
        )
        latest = await store.get_latest_job_evaluation(posting_id)
        history = await store.list_job_evaluations(posting_id)
        self.assertEqual(latest["match_score"], 27)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["match_score"], 27)
        self.assertEqual(history[1]["match_score"], 18)

    async def test_workflow_persists_evaluation_separate_from_canonical_similarity(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)

        class PassthroughNormalizer(JobNormalizer):
            def normalize(self, job_input: JobInput) -> NormalizedJobPosting:
                return NormalizedJobPosting(
                    title=job_input.title,
                    company_name=job_input.company,
                    location=job_input.location,
                    remote=False,
                    description=job_input.description,
                    url=job_input.url,
                    source=job_input.source,
                    description_hash=compute_description_hash(job_input.description),
                )

        class Provider:
            def search(self, profile):
                return [
                    JobInput(
                        company="Anthropic",
                        title="Staff AI Engineer",
                        url="https://example.com/x",
                        description=JD,
                        source="greenhouse",
                        external_job_id="x",
                    )
                ]

        workflow = JobSearchWorkflow(
            profile=JobSearchProfile(candidate_name="Jay", keywords=["ai", "llm", "agent"]),
            providers=[Provider()],
            normalizer=PassthroughNormalizer(),
            scoring=SimpleScoreCalculator(),
            memory_store=MemoryStore(tool_client=object()),
            lifecycle_resolver=resolver,
            evaluation_service=EvaluationService(store),
        )
        matches = await workflow.execute()
        self.assertEqual(len(matches), 1)
        posting_id = str(matches[0].memory_job_id)
        latest = await store.get_latest_job_evaluation(posting_id)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["match_score"], matches[0].decision.match_score)
        self.assertIn("disposition", latest.get("metadata") or {})
        # canonical similarity lives on lifecycle classification, not as match_score
        self.assertNotEqual(
            latest.get("metadata", {}).get("canonical_similarity_score"),
            latest["match_score"],
        )

    async def test_to_apply_semantics_repost_with_prior_app_still_unapplied(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        first = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/june",
                "source": "greenhouse",
                "external_job_id": "june",
                "description": JD,
                "posted_date": "2026-06-01",
            },
            resolver,
        )
        await store.record_application(
            {
                "canonical_job_id": first.canonical_job["id"],
                "posting_id": first.job_posting["id"],
                "status": "applied",
                "applied_at": "2026-06-03T00:00:00+00:00",
                "application_url": "https://example.com/june",
            }
        )
        await store.update_job_posting(
            {"id": first.job_posting["id"], "posting_status": "closed"}
        )
        repost = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/august",
                "source": "greenhouse",
                "external_job_id": "august",
                "description": JD,
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(repost.classification.disposition, PostingDisposition.REPOST)
        apps_on_repost = await store.list_applications(posting_id=repost.job_posting["id"])
        self.assertEqual(apps_on_repost, [])
        prior = await store.list_applications(canonical_job_id=first.canonical_job["id"])
        self.assertEqual(len(prior), 1)


if __name__ == "__main__":
    unittest.main()
