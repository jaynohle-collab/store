import asyncio
import unittest

from job_agent.memory.duplicate_detector import DuplicateDetector
from job_agent.models.types import JobInput
from job_agent.memory.client import MemoryStore
from job_agent.utils.normalization import compute_description_hash


class FakeMemoryStore(MemoryStore):
    def __init__(self, history):
        super().__init__(tool_client=None)
        self._history = history

    async def get_history(self):
        return self._history


class DuplicateDetectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_url_is_duplicate(self):
        history = [
            {
                "id": 1,
                "company": "OpenAI",
                "title": "Senior AI Engineer",
                "url": "https://openai.com/careers",
                "description": "Build production AI agent infrastructure.",
                "description_hash": compute_description_hash(
                    "Build production AI agent infrastructure."
                ),
                "status": "new",
            }
        ]
        detector = DuplicateDetector(FakeMemoryStore(history))
        job_input = JobInput(
            company="OpenAI",
            title="Senior AI Engineer",
            url="https://openai.com/careers",
            description="Build production AI agent infrastructure and LLM platforms",
            source="test",
        )

        result = await detector.check_duplicate(job_input)

        self.assertTrue(result.is_duplicate)
        self.assertEqual(result.reason, "same URL")
        self.assertEqual(result.matched_job_id, 1)

    async def test_same_company_title_is_not_auto_duplicate(self):
        history = [
            {
                "id": 2,
                "company": "OpenAI",
                "title": "Senior AI Engineer",
                "url": "https://openai.com/jobs/123",
                "description": "Build production AI agent infrastructure.",
                "description_hash": None,
                "status": "new",
            }
        ]
        detector = DuplicateDetector(FakeMemoryStore(history))
        job_input = JobInput(
            company="OpenAI",
            title="Senior AI Engineer",
            url="https://openai.com/careers",
            description="Build production AI agent infrastructure and LLM platforms",
            source="test",
            external_job_id="different-id",
        )

        result = await detector.check_duplicate(job_input)

        self.assertFalse(result.is_duplicate)
        self.assertTrue(result.possible_canonical_match)
        self.assertIn("canonical match", result.reason)
        self.assertEqual(result.matched_job_id, 2)

    async def test_same_source_external_id_is_duplicate(self):
        history = [
            {
                "id": 9,
                "company": "OpenAI",
                "title": "Senior AI Engineer",
                "url": "https://openai.com/jobs/old",
                "description": "Build production AI agent infrastructure.",
                "description_hash": None,
                "status": "new",
                "source": "greenhouse",
                "external_job_id": "gh-42",
            }
        ]
        detector = DuplicateDetector(FakeMemoryStore(history))
        job_input = JobInput(
            company="OpenAI",
            title="Senior AI Engineer",
            url="https://openai.com/jobs/new-url",
            description="Something else",
            source="greenhouse",
            external_job_id="gh-42",
        )

        result = await detector.check_duplicate(job_input)

        self.assertTrue(result.is_duplicate)
        self.assertEqual(result.reason, "same source and external_job_id")
        self.assertEqual(result.matched_job_id, 9)

    async def test_similar_description_is_possible_duplicate(self):
        history = [
            {
                "id": 3,
                "company": "OpenAI",
                "title": "Machine Learning Engineer, Generative AI",
                "url": "https://openai.com/jobs/456",
                "description": "Design generative AI infrastructure and agent platforms.",
                "description_hash": None,
                "status": "new",
            }
        ]
        detector = DuplicateDetector(FakeMemoryStore(history))
        job_input = JobInput(
            company="OpenAI",
            title="Senior AI Engineer",
            url="https://openai.com/careers/engineer",
            description="Build production AI agent infrastructure and LLM platforms",
            source="test",
        )

        result = await detector.check_duplicate(job_input)

        self.assertFalse(result.is_duplicate)
        self.assertGreaterEqual(result.confidence_score, 70.0)
        self.assertLess(result.confidence_score, 90.0)
        self.assertEqual(result.matched_job_id, 3)
        self.assertIn("possible duplicate", result.reason)

    async def test_different_company_not_duplicate(self):
        history = [
            {
                "id": 4,
                "company": "Google",
                "title": "Senior AI Engineer",
                "url": "https://careers.google.com/jobs/789",
                "description": "Build production AI agent infrastructure and LLM platforms.",
                "description_hash": None,
                "status": "new",
            }
        ]
        detector = DuplicateDetector(FakeMemoryStore(history))
        job_input = JobInput(
            company="OpenAI",
            title="Senior AI Engineer",
            url="https://openai.com/careers/engineer",
            description="Build production AI agent infrastructure and LLM platforms",
            source="test",
        )

        result = await detector.check_duplicate(job_input)

        self.assertFalse(result.is_duplicate)
        self.assertIsNone(result.matched_job_id)
        self.assertEqual(result.reason, "no duplicate signal")


if __name__ == "__main__":
    unittest.main()
