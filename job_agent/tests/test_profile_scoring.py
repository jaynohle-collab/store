"""Deterministic profile scoring (profile-v1) and profile loader tests."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from job_agent.examples.daily_job_run import (
    DEFAULT_PROFILE_PATH,
    resolve_job_search_profile,
)
from job_agent.lifecycle.evaluation_service import (
    PROFILE_VERSION,
    SCORING_VERSION,
    EvaluationService,
)
from job_agent.models.types import (
    JobInput,
    JobSearchProfile,
    NormalizedJobPosting,
    ScoringWeights,
)
from job_agent.profile import ProfileLoadError, load_job_search_profile
from job_agent.ranking.scoring import ProfileScoreCalculator
from job_agent.workflow.example_gpt_input import SimpleJobNormalizer

PROFILE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "data" / "job_search_profile.json"
)

STRONG_AI_JD = (
    "Build production LLM platforms and AI agent orchestration with LangGraph, "
    "MCP, RAG retrieval, distributed backend systems, cloud infrastructure, "
    "APIs/services, reliability, and scalable architecture ownership."
)

AI_BACKEND_JD = (
    "Senior AI backend engineer role building LLM services, RAG pipelines, "
    "backend APIs, cloud platforms, and production distributed systems."
)

BACKEND_ONLY_JD = (
    "Build scalable backend APIs and distributed services on cloud platforms. "
    "Own production architecture, reliability, and developer tooling. "
    "No machine learning or generative AI focus."
)

SRE_MENTION_JD = (
    "Lead AI infrastructure for LLM serving and agent platforms. "
    "Partner with SRE on reliability, Kubernetes, and production operations "
    "while owning AI platform architecture and distributed systems."
)

AGENT_PLATFORM_JD = (
    "Build production LLM agents, tool orchestration, MCP integrations, "
    "retrieval/RAG systems, distributed backend services, evaluation systems, "
    "and scalable cloud infrastructure."
)

FORWARD_DEPLOYED_JD = (
    "Deploy and customize enterprise LLM agent systems, RAG/retrieval, "
    "tool integrations, backend workflows, and production AI infrastructure "
    "for customers."
)


class ProfileLoaderTests(unittest.TestCase):
    def test_loads_production_profile(self):
        profile = load_job_search_profile(PROFILE_PATH)
        self.assertEqual(profile.profile_version, "jay-ai-v1")
        self.assertTrue(profile.remote_first)
        self.assertEqual(profile.high_match_threshold, 70)
        self.assertIsNotNone(profile.weights)
        self.assertEqual(profile.weights.total(), 100)
        self.assertIn("Staff AI Engineer", profile.target_roles or [])

    def test_weights_must_sum_to_100(self):
        payload = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        payload["weights"]["role_fit"] = 99
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ProfileLoadError):
                load_job_search_profile(path)

    def test_rejects_non_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaises(ProfileLoadError):
                load_job_search_profile(path)

    def test_threshold_bounds(self):
        payload = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        payload["high_match_threshold"] = 140
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ProfileLoadError):
                load_job_search_profile(path)

    def test_backward_compatible_job_search_profile_constructor(self):
        profile = JobSearchProfile(candidate_name="Legacy", keywords=["ai"])
        self.assertIsNone(profile.profile_version)
        self.assertIsNone(profile.weights)


class ProfileScoreCalculatorCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile = load_job_search_profile(PROFILE_PATH)
        cls.scorer = ProfileScoreCalculator()
        cls.normalizer = SimpleJobNormalizer()

    def _posting(
        self,
        *,
        title: str,
        description: str,
        location: str | None,
        remote_status: str | None,
        company: str = "Acme",
    ) -> NormalizedJobPosting:
        metadata = {}
        if remote_status is not None:
            metadata["remote_status"] = remote_status
        job = JobInput(
            company=company,
            title=title,
            url="https://example.com/job",
            description=description,
            source="test",
            location=location,
            metadata=metadata or None,
        )
        return self.normalizer.normalize(job)

    def _score(self, posting: NormalizedJobPosting):
        return self.scorer.score_detailed(posting, self.profile)

    def test_case_a_staff_agent_platform_high(self):
        posting = self._posting(
            title="Staff AI Engineer, Agent Platform",
            description=STRONG_AI_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreaterEqual(result.total, 80)
        self.assertLessEqual(result.total, 100)

    def test_case_b_senior_ai_backend_hybrid(self):
        posting = self._posting(
            title="Senior AI Backend Engineer",
            description=AI_BACKEND_JD,
            location="United States",
            remote_status="Hybrid",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreaterEqual(result.total, 70)

    def test_case_c_backend_without_ai_below_threshold(self):
        posting = self._posting(
            title="Senior Backend Engineer",
            description=BACKEND_ONLY_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertLess(result.total, self.profile.high_match_threshold or 70)

    def test_case_d_junior_hard_reject(self):
        posting = self._posting(
            title="Junior AI Engineer",
            description=STRONG_AI_JD,
            location="Remote",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertTrue(result.hard_reject)
        self.assertEqual(result.total, 0)

    def test_case_e_frontend_hard_reject(self):
        posting = self._posting(
            title="Frontend Engineer",
            description="Build React UI components and CSS systems.",
            location="Remote",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertTrue(result.hard_reject)
        self.assertEqual(result.total, 0)

    def test_case_f_pure_sre_hard_reject(self):
        posting = self._posting(
            title="Site Reliability Engineer",
            description="Own Kubernetes reliability and on-call for services.",
            location="Remote",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertTrue(result.hard_reject)
        self.assertEqual(result.total, 0)

    def test_case_g_ai_infra_with_sre_mention_not_rejected(self):
        posting = self._posting(
            title="Senior AI Infrastructure Engineer",
            description=SRE_MENTION_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreater(result.total, 0)

    def test_case_h_nyc_onsite_hard_reject(self):
        posting = self._posting(
            title="Senior AI Engineer",
            description=STRONG_AI_JD,
            location="New York, NY",
            remote_status="Onsite",
        )
        result = self._score(posting)
        self.assertTrue(result.hard_reject)
        self.assertEqual(result.total, 0)
        self.assertEqual(result.reject_reason, "nyc_onsite_only")

    def test_case_i_nyc_remote_not_rejected(self):
        posting = self._posting(
            title="Senior AI Engineer",
            description=STRONG_AI_JD,
            location="New York, NY",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreater(result.total, 0)

    def test_case_j_us_remote_full_remote_points(self):
        posting = self._posting(
            title="Senior AI Engineer",
            description=STRONG_AI_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertEqual(result.remote_location, 10.0)
        self.assertFalse(result.hard_reject)

    def test_score_always_within_0_100(self):
        samples = [
            ("Staff AI Engineer, Agent Platform", STRONG_AI_JD, "Remote", "Remote"),
            ("Senior Backend Engineer", BACKEND_ONLY_JD, "US", "Hybrid"),
            ("Principal AI Engineer", AI_BACKEND_JD, "United States", "Remote"),
            ("Software Engineer", "General programming.", "Austin, TX", "Onsite"),
        ]
        for title, description, location, remote_status in samples:
            posting = self._posting(
                title=title,
                description=description,
                location=location,
                remote_status=remote_status,
            )
            total = self.scorer.score(posting, self.profile)
            self.assertGreaterEqual(total, 0)
            self.assertLessEqual(total, 100)

    def test_normalizer_preserves_remote_status(self):
        posting = self._posting(
            title="Senior AI Engineer",
            description=STRONG_AI_JD,
            location="United States",
            remote_status="Remote",
        )
        self.assertEqual(posting.remote_status, "Remote")
        self.assertTrue(posting.remote)

        onsite = self._posting(
            title="Senior AI Engineer",
            description=STRONG_AI_JD,
            location="New York, NY",
            remote_status="Onsite",
        )
        self.assertEqual(onsite.remote_status, "Onsite")
        self.assertFalse(onsite.remote)

    def test_evaluation_version_defaults(self):
        self.assertEqual(SCORING_VERSION, "profile-v1")
        self.assertEqual(PROFILE_VERSION, "jay-ai-v1")
        self.assertEqual(self.profile.profile_version, "jay-ai-v1")

        class _Store:
            async def save_job_evaluation(self, payload):
                return payload

            async def get_latest_job_evaluation(self, posting_id):
                return None

            async def list_job_evaluations(self, posting_id, limit=50):
                return []

        svc = EvaluationService(_Store())
        self.assertEqual(svc.scoring_version, "profile-v1")
        self.assertEqual(svc.profile_version, "jay-ai-v1")

    def test_agent_platform_title_without_literal_ai(self):
        """Explicit Agent Platform target role must not require the word AI."""
        posting = self._posting(
            title="Senior Software Engineer, Agent Platform",
            description=AGENT_PLATFORM_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreaterEqual(result.role_fit, 20.0)
        self.assertGreaterEqual(result.total, 80.0)

    def test_forward_deployed_engineer_explicit_target_role(self):
        posting = self._posting(
            title="Forward Deployed Engineer",
            description=FORWARD_DEPLOYED_JD,
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertGreaterEqual(result.role_fit, 20.0)
        self.assertGreaterEqual(result.total, 70.0)

    def test_generic_software_engineer_not_auto_high_match(self):
        posting = self._posting(
            title="Senior Software Engineer",
            description="Build backend services and APIs on cloud platforms.",
            location="United States",
            remote_status="Remote",
        )
        result = self._score(posting)
        self.assertFalse(result.hard_reject)
        self.assertLess(result.total, self.profile.high_match_threshold or 70)
        self.assertLess(result.role_fit, 15.0)

    def test_profile_weights_drive_component_maxima(self):
        """JSON/profile weights must set component maxima, not decorative defaults."""
        posting = self._posting(
            title="Senior AI Backend Engineer",
            description=AI_BACKEND_JD,
            location="United States",
            remote_status="Hybrid",
        )
        baseline = self._score(posting)
        self.assertEqual(self.profile.weights.remote_location, 10.0)
        self.assertEqual(baseline.remote_location, 5.0)  # half of weight 10
        self.assertLessEqual(baseline.role_fit, self.profile.weights.role_fit)

        reweighted = replace(
            self.profile,
            weights=ScoringWeights(
                role_fit=15.0,
                ai_technical_fit=25.0,
                backend_platform_production=15.0,
                seniority=15.0,
                remote_location=30.0,
            ),
        )
        self.assertEqual(reweighted.weights.total(), 100.0)

        changed = self.scorer.score_detailed(posting, reweighted)
        self.assertEqual(changed.remote_location, 15.0)  # half of weight 30
        self.assertLessEqual(changed.role_fit, 15.0)
        self.assertNotEqual(changed.remote_location, baseline.remote_location)
        self.assertNotEqual(changed.total, baseline.total)
        self.assertLessEqual(changed.role_fit, reweighted.weights.role_fit)
        self.assertLessEqual(changed.ai_technical_fit, reweighted.weights.ai_technical_fit)
        self.assertLessEqual(
            changed.backend_platform_production,
            reweighted.weights.backend_platform_production,
        )
        self.assertLessEqual(changed.seniority, reweighted.weights.seniority)
        self.assertLessEqual(changed.remote_location, reweighted.weights.remote_location)


class DefaultProfilePathTests(unittest.TestCase):
    def test_default_profile_path_is_repo_absolute(self):
        self.assertTrue(DEFAULT_PROFILE_PATH.is_absolute())
        self.assertTrue(DEFAULT_PROFILE_PATH.is_file())
        self.assertEqual(DEFAULT_PROFILE_PATH.name, "job_search_profile.json")

    def test_resolve_profile_independent_of_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = Path.cwd()
            try:
                os.chdir(tmp)
                self.assertFalse(Path("data/job_search_profile.json").exists())
                profile = resolve_job_search_profile()
                self.assertEqual(profile.profile_version, "jay-ai-v1")
                self.assertEqual(profile.high_match_threshold, 70)
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
