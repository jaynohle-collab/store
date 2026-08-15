"""Deterministic tests for job lifecycle / repost / application tracking."""

from __future__ import annotations

import unittest
from datetime import date

from job_agent.lifecycle.application_service import ApplicationService
from job_agent.lifecycle.classifier import PostingLifecycleClassifier
from job_agent.lifecycle.memory_store import InMemoryLifecycleStore
from job_agent.lifecycle.process import DiscoveryRunTracker, process_discovered_job, to_apply_signals
from job_agent.lifecycle.resolver import CanonicalJobResolver, normalize_raw_job
from job_agent.lifecycle.types import PostingDisposition
from job_agent.lifecycle.url import normalize_url


class UrlNormalizationTests(unittest.TestCase):
    def test_strips_tracking_params_and_slash(self):
        left = normalize_url("https://Example.com/jobs/1/?utm_source=x")
        right = normalize_url("https://example.com/jobs/1")
        self.assertEqual(left, right)


class PostingLifecycleClassifierTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.classifier = PostingLifecycleClassifier(min_gap_days=14)

    def test_same_url_is_same_posting(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://boards.greenhouse.io/anthropic/jobs/123?utm_source=x",
                "source": "greenhouse",
                "description": "Build AI systems",
                "external_job_id": "123",
            }
        )
        existing = [
            {
                "id": "p1",
                "canonical_job_id": "c1",
                "normalized_url": "https://boards.greenhouse.io/anthropic/jobs/123",
                "url": "https://boards.greenhouse.io/anthropic/jobs/123",
                "source": "greenhouse",
                "external_job_id": "999",
            }
        ]
        result = self.classifier.classify(candidate, existing)
        self.assertEqual(result.disposition, PostingDisposition.SAME_POSTING)
        self.assertIn("same_normalized_url", result.signals)

    def test_same_source_external_id_is_same_posting(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/a",
                "source": "greenhouse",
                "external_job_id": "gh-55",
                "description": "Build AI systems",
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
        self.assertEqual(result.reason, "same source and external_job_id")

    def test_same_company_title_new_external_and_date_is_repost(self):
        candidate = normalize_raw_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://boards.greenhouse.io/anthropic/jobs/999",
                "source": "greenhouse",
                "external_job_id": "999",
                "description": "Build production AI agent systems and platforms",
                "posted_date": "2026-08-15",
            }
        )
        existing_postings = [
            {
                "id": "p-old",
                "canonical_job_id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
                "source": "greenhouse",
                "external_job_id": "111",
                "normalized_url": "https://boards.greenhouse.io/anthropic/jobs/111",
                "url": "https://boards.greenhouse.io/anthropic/jobs/111",
                "description": "Build production AI agent systems and platforms",
                "description_hash": candidate.description_hash,
                "posted_date": "2026-06-01",
                "posting_status": "closed",
            }
        ]
        existing_canonicals = [
            {
                "id": "c1",
                "company": "Anthropic",
                "company_key": "anthropic",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing_postings, existing_canonicals)
        self.assertEqual(result.disposition, PostingDisposition.REPOST)
        self.assertEqual(result.canonical_job_id, "c1")
        self.assertEqual(result.previous_posting_id, "p-old")
        self.assertTrue(
            any(
                s in result.signals
                for s in (
                    "different_external_job_id",
                    "new_posted_date",
                    "source_reports_new_posting_id",
                    "previous_posting_closed",
                )
            )
        )

    def test_same_company_title_without_repost_signals_is_new_job(self):
        candidate = normalize_raw_job(
            {
                "company": "Acme",
                "title": "Platform Engineer",
                "url": "https://acme.com/jobs/b",
                "source": "careers",
                "description": (
                    "Manage Salesforce CRM configurations, sales pipelines, and "
                    "customer success tooling for account executives"
                ),
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
                "normalized_url": "https://acme.com/jobs/a",
                "description": (
                    "Own Kubernetes clusters, CI/CD, and cloud infrastructure for "
                    "developer platforms at scale"
                ),
                "description_hash": "abcd1234abcd1234",
            }
        ]
        canonicals = [
            {
                "id": "c1",
                "company_key": "acme",
                "normalized_title": "platform engineer",
                "role_family": "engineering",
            }
        ]
        result = self.classifier.classify(candidate, existing, canonicals)
        self.assertEqual(result.disposition, PostingDisposition.NEW_JOB)


class LifecyclePersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_repost_creates_new_posting_reuses_canonical(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)

        first = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/a",
                "source": "greenhouse",
                "external_job_id": "A1",
                "description": "Build AI systems with agents and LLMs",
                "posted_date": "2026-06-01",
            },
            resolver,
        )
        self.assertEqual(first.classification.disposition, PostingDisposition.NEW_JOB)
        canonical_id = first.canonical_job["id"]
        posting_a = first.job_posting["id"]
        first_seen = first.job_posting["first_seen_at"]

        # Close old posting so rediscovery has a supporting signal.
        await store.update_job_posting({"id": posting_a, "posting_status": "closed"})

        second = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/b",
                "source": "greenhouse",
                "external_job_id": "B2",
                "description": "Build AI systems with agents and LLMs",
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(second.classification.disposition, PostingDisposition.REPOST)
        self.assertEqual(second.canonical_job["id"], canonical_id)
        self.assertNotEqual(second.job_posting["id"], posting_a)
        self.assertTrue(second.job_posting["is_repost"])
        self.assertEqual(second.job_posting["supersedes_posting_id"], posting_a)

        # SAME_POSTING does not create duplicate row; first_seen stable; last_seen updates.
        third = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/b",
                "source": "greenhouse",
                "external_job_id": "B2",
                "description": "Build AI systems with agents and LLMs",
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(third.classification.disposition, PostingDisposition.SAME_POSTING)
        self.assertEqual(third.job_posting["id"], second.job_posting["id"])
        self.assertEqual(third.job_posting["first_seen_at"], second.job_posting["first_seen_at"])
        self.assertIsNotNone(third.job_posting["last_seen_at"])
        # Rediscovery refreshes last_seen_at via update path (may equal prior if same clock tick).
        updated = store.job_postings[second.job_posting["id"]]
        self.assertEqual(updated["first_seen_at"], second.job_posting["first_seen_at"])
        self.assertEqual(len(store.job_postings), 2)

        # first_seen on original posting remains stable after updates
        original = store.job_postings[posting_a]
        self.assertEqual(original["first_seen_at"], first_seen)

    async def test_application_history_preserved_across_repost(self):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        apps = ApplicationService(store)

        first = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/june",
                "source": "greenhouse",
                "external_job_id": "june",
                "description": "Staff AI work",
                "posted_date": "2026-06-01",
            },
            resolver,
        )
        application = await apps.record_application(
            canonical_job_id=first.canonical_job["id"],
            posting_id=first.job_posting["id"],
            status="applied",
            application_url="https://example.com/jobs/june",
            notes="Applied in June",
        )
        await apps.add_event(
            application_id=application["id"],
            event_type="recruiter_screen",
            notes="Phone screen completed",
        )

        await store.update_job_posting(
            {"id": first.job_posting["id"], "posting_status": "closed"}
        )

        repost = await process_discovered_job(
            {
                "company": "Anthropic",
                "title": "Staff AI Engineer",
                "url": "https://example.com/jobs/august",
                "source": "greenhouse",
                "external_job_id": "august",
                "description": "Staff AI work",
                "posted_date": "2026-08-15",
            },
            resolver,
        )
        self.assertEqual(repost.classification.disposition, PostingDisposition.REPOST)

        # Old application still attached to posting A
        old_apps = await apps.list_for_posting(first.job_posting["id"])
        self.assertEqual(len(old_apps), 1)
        self.assertEqual(old_apps[0]["id"], application["id"])

        # New posting remains unapplied
        new_apps = await apps.list_for_posting(repost.job_posting["id"])
        self.assertEqual(new_apps, [])
        self.assertFalse(await apps.has_application_for_posting(repost.job_posting["id"]))

        events = await store.list_application_events(application["id"])
        self.assertGreaterEqual(len(events), 2)
        types = {e["event_type"] for e in events}
        self.assertIn("applied", types)
        self.assertIn("recruiter_screen", types)

        prior = await apps.prior_applications_on_canonical(
            first.canonical_job["id"],
            excluding_posting_id=repost.job_posting["id"],
        )
        self.assertEqual(len(prior), 1)

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
                "description": "alpha role description text",
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
                "description": "alpha role description text",
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
                "description": "alpha role description text",
                "posted_date": "2026-03-01",
            },
            resolver,
        )
        tracker.record(r3)

        payload = tracker.to_payload()
        self.assertEqual(payload["jobs_discovered"], 3)
        self.assertEqual(payload["new_jobs"], 1)
        self.assertEqual(payload["reposts"], 1)
        self.assertEqual(payload["duplicates"], 1)

        saved = await tracker.persist(store)
        self.assertEqual(saved["duplicates"], 1)

    async def test_to_apply_signals_do_not_hardcode_policy(self):
        signals = to_apply_signals(
            posting={"posting_status": "active"},
            match_score=0.8,
            match_threshold=0.7,
            has_application_for_posting=False,
        )
        self.assertTrue(signals["candidate_to_apply"])
        signals2 = to_apply_signals(
            posting={"posting_status": "active"},
            match_score=0.8,
            match_threshold=0.7,
            has_application_for_posting=True,
        )
        self.assertFalse(signals2["candidate_to_apply"])


class DuplicateDetectorLifecycleAlignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_company_title_is_not_auto_discard(self):
        from job_agent.memory.duplicate_detector import DuplicateDetector
        from job_agent.memory.client import MemoryStore
        from job_agent.models.types import JobInput

        class Fake(MemoryStore):
            def __init__(self):
                super().__init__(tool_client=None)

            async def get_history(self):
                return [
                    {
                        "id": "old",
                        "company": "OpenAI",
                        "title": "Senior AI Engineer",
                        "url": "https://openai.com/jobs/123",
                        "description": "Build stuff",
                        "description_hash": None,
                        "source": "careers",
                    }
                ]

        detector = DuplicateDetector(Fake())
        result = await detector.check_duplicate(
            JobInput(
                company="OpenAI",
                title="Senior AI Engineer",
                url="https://openai.com/careers/new",
                description="Different wording for the same role family",
                source="careers",
                external_job_id="new-id",
            )
        )
        self.assertFalse(result.is_duplicate)
        self.assertTrue(result.possible_canonical_match)


if __name__ == "__main__":
    unittest.main()
