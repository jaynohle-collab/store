"""Deterministic tests for job lifecycle / repost / application tracking."""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock

from job_agent.lifecycle.application_service import (
    ApplicationIntegrityError,
    ApplicationService,
)
from job_agent.lifecycle.classifier import PostingLifecycleClassifier
from job_agent.lifecycle.memory_store import InMemoryLifecycleStore
from job_agent.lifecycle.process import DiscoveryRunTracker, process_discovered_job
from job_agent.lifecycle.resolver import CanonicalJobResolver, normalize_raw_job
from job_agent.lifecycle.similarity import (
    CANONICAL_MATCH_THRESHOLD,
    CanonicalJobSimilarityScorer,
)
from job_agent.lifecycle.types import PostingDisposition
from job_agent.lifecycle.url import normalize_url
from job_agent.memory.client import MemoryStore
from job_agent.memory.duplicate_detector import DuplicateDetector
from job_agent.memory.fingerprint import compute_description_hash
from job_agent.models.types import JobInput, JobSearchProfile, NormalizedJobPosting
from job_agent.ranking.scoring import SimpleScoreCalculator
from job_agent.search.interfaces import JobNormalizer
from job_agent.workflow.engine import JobSearchWorkflow


JD_AI = (
    "Build production AI agent systems, LLM platforms, retrieval pipelines, "
    "and evaluation harnesses for large language model applications."
)

JD_SALESFORCE = (
    "Configure Salesforce CRM objects, sales pipelines, account hierarchies, "
    "and customer success workflows for revenue operations teams."
)

JD_K8S = (
    "Own Kubernetes clusters, CI/CD, cloud networking, and developer platform "
    "tooling including Terraform and observability stacks."
)


class UrlNormalizationTests(unittest.TestCase):
    def test_strips_tracking_params_and_slash(self):
        left = normalize_url("https://Example.com/jobs/1/?utm_source=x")
        right = normalize_url("https://example.com/jobs/1")
        self.assertEqual(left, right)


class CanonicalSimilarityTests(unittest.TestCase):
    def setUp(self):
        self.scorer = CanonicalJobSimilarityScorer()

    def test_company_is_hard_gate(self):
        left = normalize_raw_job(
            {"company": "Anthropic", "title": "Staff AI Engineer", "description": JD_AI, "source": "t"}
        )
        right = normalize_raw_job(
            {"company": "OpenAI", "title": "Staff AI Engineer", "description": JD_AI, "source": "t"}
        )
        result = self.scorer.score(left, right)
        self.assertFalse(result.signals["company_match"])
        self.assertEqual(result.canonical_similarity_score, 0.0)

    def test_fuzzy_title_and_similar_jd_same_company(self):
        left = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "description": JD_AI,
                "source": "t",
            }
        )
        right = {
            "company": "Anthropic",
            "company_key": "anthropic",
            "title": "Staff Artificial Intelligence Engineer",
            "normalized_title": "staff artificial intelligence engineer",
            "role_family": "engineering",
            "description": JD_AI,
            "description_hash": compute_description_hash(JD_AI),
        }
        result = self.scorer.score(left, right)
        self.assertTrue(result.signals["company_match"])
        self.assertGreaterEqual(result.canonical_similarity_score, CANONICAL_MATCH_THRESHOLD)
        self.assertTrue(result.is_confident_match)

    def test_independent_of_candidate_match_score(self):
        left = normalize_raw_job(
            {"company": "Acme", "title": "Platform Engineer", "description": JD_K8S, "source": "t"}
        )
        right = normalize_raw_job(
            {"company": "Acme", "title": "Platform Engineer", "description": JD_K8S, "source": "t"}
        )
        a = self.scorer.score(left, right)
        # Candidate match_score is a separate concept — scorer has no access to it.
        self.assertIn("canonical_similarity_score", a.to_dict())
        self.assertNotIn("match_score", a.to_dict())
        self.assertNotIn("resume", str(a.to_dict()).lower())


class PostingIdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.classifier = PostingLifecycleClassifier(min_gap_days=14)

    def test_exact_url_same_posting(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://boards.greenhouse.io/anthropic/jobs/123?utm_source=x",
                "source": "greenhouse",
                "description": JD_AI,
                "external_job_id": "other",
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "normalized_url": "https://boards.greenhouse.io/anthropic/jobs/123",
                "source": "greenhouse",
                "external_job_id": "999",
            }
        ]
        result = self.classifier.classify(candidate, existing)
        self.assertEqual(result.disposition, PostingDisposition.SAME_POSTING)

    def test_exact_source_external_id_same_posting(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/a",
                "source": "greenhouse",
                "external_job_id": "gh-55",
                "description": JD_AI,
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "source": "greenhouse",
                "external_job_id": "gh-55",
                "normalized_url": "https://example.com/old",
            }
        ]
        result = self.classifier.classify(candidate, existing)
        self.assertEqual(result.disposition, PostingDisposition.SAME_POSTING)

    def test_identical_description_is_not_identity(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/new",
                "source": "greenhouse",
                "external_job_id": "new",
                "description": JD_AI,
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
                "source": "greenhouse",
                "external_job_id": "old",
                "normalized_url": "https://example.com/old",
                "description": JD_AI,
                "description_hash": compute_description_hash(JD_AI),
                # No posted_date / closed status → insufficient alone for forced SAME
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        self.assertNotEqual(result.disposition, PostingDisposition.SAME_POSTING)
        # identical description can support REPOST when identity differs
        self.assertEqual(result.disposition, PostingDisposition.REPOST)
        self.assertIn("identical_description", result.signals)
        self.assertIsNotNone(result.canonical_similarity_score)

    def test_identical_jd_repost(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/august",
                "source": "greenhouse",
                "external_job_id": "aug",
                "description": JD_AI,
                "posted_date": "2026-08-15",
            }
        )
        existing = [
            {
                "id": "p-old",
                "canonical_job_id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
                "source": "greenhouse",
                "external_job_id": "june",
                "normalized_url": "https://example.com/june",
                "description": JD_AI,
                "description_hash": compute_description_hash(JD_AI),
                "posted_date": "2026-06-01",
                "posting_status": "closed",
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        self.assertEqual(result.disposition, PostingDisposition.REPOST)
        self.assertEqual(result.canonical_job_id, "c1")
        self.assertGreaterEqual(result.canonical_similarity_score or 0, CANONICAL_MATCH_THRESHOLD)

    def test_fuzzy_title_high_jd_same_canonical(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff Artificial Intelligence Engineer",
                "url": "https://example.com/b",
                "source": "greenhouse",
                "external_job_id": "b",
                "description": JD_AI,
                "posted_date": "2026-08-15",
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
                "source": "greenhouse",
                "external_job_id": "a",
                "normalized_url": "https://example.com/a",
                "description": JD_AI,
                "description_hash": compute_description_hash(JD_AI),
                "posted_date": "2026-01-01",
                "posting_status": "closed",
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        self.assertEqual(result.disposition, PostingDisposition.REPOST)
        self.assertEqual(result.canonical_job_id, "c1")

    def test_similar_title_different_responsibilities_new_job(self):
        candidate = normalize_raw_job(
            {
                "company": "Acme",
                "title": "Platform Engineer",
                "url": "https://acme.com/jobs/sf",
                "source": "careers",
                "external_job_id": "sf",
                "description": JD_SALESFORCE,
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "company": "Acme",
                "company_key": "acme",
                "title": "Platform Engineer",
                "normalized_title": "platform engineer",
                "role_family": "engineering",
                "source": "careers",
                "external_job_id": "k8s",
                "normalized_url": "https://acme.com/jobs/k8s",
                "description": JD_K8S,
                "description_hash": compute_description_hash(JD_K8S),
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company_key": "acme",
                "title": "Platform Engineer",
                "normalized_title": "platform engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        self.assertEqual(result.disposition, PostingDisposition.NEW_JOB)

    def test_same_title_company_alone_does_not_force_repost(self):
        candidate = normalize_raw_job(
            {
                "company": "Acme",
                "title": "Platform Engineer",
                "url": "https://acme.com/jobs/b",
                "source": "careers",
                "description": "Short ambiguous blurb",
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "company": "Acme",
                "company_key": "acme",
                "title": "Platform Engineer",
                "normalized_title": "platform engineer",
                "role_family": "engineering",
                "normalized_url": "https://acme.com/jobs/a",
                "description": "Another short ambiguous blurb about platforms",
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company_key": "acme",
                "normalized_title": "platform engineer",
                "role_family": "engineering",
                "title": "Platform Engineer",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        # Without strong lifecycle signals, do not force REPOST.
        self.assertNotEqual(result.disposition, PostingDisposition.REPOST)


class LifecyclePersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_identical_jd_different_ids_later_date_repost(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        first = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/a",
                "source": "greenhouse",
                "external_job_id": "A1",
                "description": JD_AI,
                "posted_date": "2026-06-01",
            },
            resolver,
        )
        await store.update_job_posting(
            {"id": first.job_posting["id"], "posting_status": "closed"}
        )
        second = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/b",
                "source": "greenhouse",
                "external_job_id": "B2",
                "description": JD_AI,
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(second.classification.disposition, PostingDisposition.REPOST)
        self.assertEqual(second.canonical_job["id"], first.canonical_job["id"])
        self.assertNotEqual(second.job_posting["id"], first.job_posting["id"])

    async def test_old_canonical_beyond_recent_noise_still_resolved(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)

        historical = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/old",
                "source": "greenhouse",
                "external_job_id": "old",
                "description": JD_AI,
                "posted_date": "2025-01-01",
            },
            resolver,
        )
        await store.update_job_posting(
            {"id": historical.job_posting["id"], "posting_status": "closed"}
        )

        # Create many other-company canonicals/postings (noise).
        for i in range(520):
            await store.save_canonical_job(
                {
                    "company": f"NoiseCo{i}",
                    "company_key": f"noiseco{i}",
                    "title": "Engineer",
                    "normalized_title": "engineer",
                    "role_family": "engineering",
                }
            )

        repost = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/new",
                "source": "greenhouse",
                "external_job_id": "new",
                "description": JD_AI,
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(repost.classification.disposition, PostingDisposition.REPOST)
        self.assertEqual(repost.canonical_job["id"], historical.canonical_job["id"])

    async def test_application_rejects_mismatched_canonical(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        apps = ApplicationService(store)

        a = await process_discovered_job(
            {
                "company": "A",
                "title": "Eng",
                "url": "https://a/1",
                "source": "s",
                "external_job_id": "1",
                "description": JD_AI,
            },
            resolver,
        )
        b = await process_discovered_job(
            {
                "company": "B",
                "title": "Eng",
                "url": "https://b/1",
                "source": "s",
                "external_job_id": "2",
                "description": JD_K8S,
            },
            resolver,
        )
        with self.assertRaises(ApplicationIntegrityError):
            await apps.record_application(
                canonical_job_id=a.canonical_job["id"],
                posting_id=b.job_posting["id"],
                status="applied",
            )

    async def test_application_history_survives_repost_and_repost_unapplied(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        apps = ApplicationService(store)

        first = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/june",
                "source": "greenhouse",
                "external_job_id": "june",
                "description": JD_AI,
                "posted_date": "2026-06-01",
            },
            resolver,
        )
        application = await apps.record_application(
            canonical_job_id=first.canonical_job["id"],
            posting_id=first.job_posting["id"],
            status="applied",
            application_url="https://example.com/june",
        )
        await apps.add_event(
            application_id=application["id"],
            event_type="recruiter_screen",
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
                "description": JD_AI,
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(repost.classification.disposition, PostingDisposition.REPOST)
        old_apps = await apps.list_for_posting(first.job_posting["id"])
        self.assertEqual(len(old_apps), 1)
        self.assertEqual(await apps.list_for_posting(repost.job_posting["id"]), [])
        events = await store.list_application_events(application["id"])
        self.assertGreaterEqual(len(events), 2)

    async def test_canonical_similarity_independent_of_match_score(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        result = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/x",
                "source": "greenhouse",
                "external_job_id": "x",
                "description": JD_AI,
            },
            resolver,
            match_score=12.5,
        )
        payload = result.to_dict()
        self.assertEqual(payload["match_score"], 12.5)
        # NEW_JOB has no canonical similarity score required
        self.assertIsNone(payload["canonical_similarity_score"])

        await store.update_job_posting(
            {"id": result.job_posting["id"], "posting_status": "closed"}
        )
        repost = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/y",
                "source": "greenhouse",
                "external_job_id": "y",
                "description": JD_AI,
                "posted_date": "2026-08-15",
            },
            resolver,
            match_score=99.0,
        )
        self.assertEqual(repost.match_score, 99.0)
        self.assertIsNotNone(repost.classification.canonical_similarity_score)
        self.assertNotEqual(
            repost.classification.canonical_similarity_score,
            repost.match_score,
        )


class DuplicateDetectorDescriptionHashTests(unittest.IsolatedAsyncioTestCase):
    async def test_identical_description_hash_not_auto_duplicate(self):
        desc_hash = compute_description_hash(JD_AI)

        class Fake(MemoryStore):
            def __init__(self):
                super().__init__(tool_client=None)

            async def get_history(self):
                return [
                    {
                        "id": "old",
                        "company": "Anthropic",
                        "title": "Staff AI Engineer",
                        "url": "https://example.com/old",
                        "description": JD_AI,
                        "description_hash": desc_hash,
                        "source": "greenhouse",
                        "external_job_id": "old",
                    }
                ]

        detector = DuplicateDetector(Fake())
        result = await detector.check_duplicate(
            JobInput(
                company="Anthropic",
                title="Staff AI Engineer",
                url="https://example.com/new",
                description=JD_AI,
                source="greenhouse",
                external_job_id="new",
            )
        )
        self.assertFalse(result.is_duplicate)
        self.assertTrue(result.possible_canonical_match)
        self.assertIn("description hash", result.reason)


class WorkflowBatchDedupeTests(unittest.IsolatedAsyncioTestCase):
    async def test_identical_description_different_ids_not_discarded_before_lifecycle(self):
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
                        url="https://example.com/a",
                        description=JD_AI,
                        source="greenhouse",
                        external_job_id="A",
                        posted_date=__import__("datetime").date(2026, 6, 1),
                    ),
                    JobInput(
                        company="Anthropic",
                        title="Staff AI Engineer",
                        url="https://example.com/b",
                        description=JD_AI,
                        source="greenhouse",
                        external_job_id="B",
                        posted_date=__import__("datetime").date(2026, 8, 15),
                    ),
                ]

        # Mark first posting closed between classifications by wrapping process path:
        # After first job saves, close it so second becomes REPOST.
        original_apply = resolver.apply_persistence_plan

        async def apply_and_maybe_close(posting, plan, classification):
            canonical, job_posting = await original_apply(posting, plan, classification)
            if plan.disposition == PostingDisposition.NEW_JOB and job_posting:
                await store.update_job_posting(
                    {"id": job_posting["id"], "posting_status": "closed"}
                )
            return canonical, job_posting

        resolver.apply_persistence_plan = apply_and_maybe_close  # type: ignore

        workflow = JobSearchWorkflow(
            profile=JobSearchProfile(candidate_name="Jay", keywords=["ai"]),
            providers=[Provider()],
            normalizer=PassthroughNormalizer(),
            scoring=SimpleScoreCalculator(),
            memory_store=MemoryStore(tool_client=MagicMock()),
            lifecycle_resolver=resolver,
        )
        matches = await workflow.execute()
        self.assertEqual(len(matches), 2)
        self.assertEqual(matches[0].decision.recommendation, "save")
        self.assertEqual(matches[1].decision.recommendation, "save_repost")
        self.assertFalse(matches[1].decision.duplicate)

    async def test_lifecycle_preserves_remote_status_and_salary_metadata(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)

        class PassthroughNormalizer(JobNormalizer):
            def normalize(self, job_input: JobInput) -> NormalizedJobPosting:
                return NormalizedJobPosting(
                    title=job_input.title,
                    company_name=job_input.company,
                    location=job_input.location,
                    remote=True,
                    description=job_input.description,
                    url=job_input.url,
                    source=job_input.source,
                    description_hash=compute_description_hash(job_input.description),
                )

        class Provider:
            def search(self, profile):
                return [
                    JobInput(
                        company="Example AI",
                        title="Staff AI Engineer",
                        url="https://example.com/jobs/staff-ai",
                        description=JD_AI,
                        source="company-careers",
                        location="Remote, US",
                        metadata={
                            "remote_status": "Remote",
                            "salary": "$220k-$280k",
                        },
                        external_job_id="staff-ai-1",
                        posted_date=__import__("datetime").date(2026, 8, 16),
                    )
                ]

        workflow = JobSearchWorkflow(
            profile=JobSearchProfile(candidate_name="Jay", keywords=["ai"]),
            providers=[Provider()],
            normalizer=PassthroughNormalizer(),
            scoring=SimpleScoreCalculator(),
            memory_store=MemoryStore(tool_client=MagicMock()),
            lifecycle_resolver=resolver,
        )

        matches = await workflow.execute()

        self.assertEqual(len(matches), 1)
        persisted = next(iter(store.job_postings.values()))
        self.assertEqual(persisted["remote_status"], "Remote")
        self.assertEqual(persisted["salary"], "$220k-$280k")


class DiscoveryRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_run_counts(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        tracker = DiscoveryRunTracker(source="test")

        r1 = await process_discovered_job(
            {
                "company": "A",
                "title": "Eng",
                "url": "https://x/1",
                "source": "s",
                "external_job_id": "1",
                "description": JD_AI,
                "posted_date": "2026-01-01",
            },
            resolver,
        )
        tracker.record(r1)
        await store.update_job_posting(
            {"id": r1.job_posting["id"], "posting_status": "closed"}
        )
        r2 = await process_discovered_job(
            {
                "company": "A",
                "title": "Eng",
                "url": "https://x/2",
                "source": "s",
                "external_job_id": "2",
                "description": JD_AI,
                "posted_date": "2026-03-01",
            },
            resolver,
        )
        tracker.record(r2)
        r3 = await process_discovered_job(
            {
                "company": "A",
                "title": "Eng",
                "url": "https://x/2",
                "source": "s",
                "external_job_id": "2",
                "description": JD_AI,
                "posted_date": "2026-03-01",
            },
            resolver,
        )
        tracker.record(r3)
        payload = tracker.to_payload()
        self.assertEqual(payload["new_jobs"], 1)
        self.assertEqual(payload["reposts"], 1)
        self.assertEqual(payload["duplicates"], 1)


if __name__ == "__main__":
    unittest.main()
