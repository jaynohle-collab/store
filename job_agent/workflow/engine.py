from __future__ import annotations
import asyncio
import logging
from typing import Iterable

from ..models.types import (
    JobDecision,
    JobFingerprint,
    JobInput,
    JobMatch,
    JobSearchProfile,
    NormalizedJobPosting,
)
from ..memory.client import MemoryStore
from ..memory.duplicate_detector import DuplicateDetector, POSSIBLE_DUPLICATE_THRESHOLD
from ..ranking.scoring import ScoreCalculator
from ..search.interfaces import JobNormalizer, JobSearchProvider
from ..utils.normalization import normalize_company_name, normalize_title

logger = logging.getLogger(__name__)


class JobSearchWorkflow:
    """Orchestrates search, deduplication, scoring, and memory persistence."""

    def __init__(
        self,
        profile: JobSearchProfile,
        providers: list[JobSearchProvider],
        normalizer: JobNormalizer,
        scoring: ScoreCalculator,
        memory_store: MemoryStore,
        duplicate_detector: DuplicateDetector | None = None,
    ):
        self.profile = profile
        self.providers = providers
        self.normalizer = normalizer
        self.scoring = scoring
        self.memory_store = memory_store
        self.duplicate_detector = duplicate_detector or DuplicateDetector(self.memory_store)

    async def execute(self) -> list[JobMatch]:
        job_inputs = await self._search_all_sources()
        matches: list[JobMatch] = []
        seen_urls: set[str] = set()
        seen_company_title: set[tuple[str, str]] = set()
        seen_hashes: set[str] = set()

        for job_input in job_inputs:
            logger.info("received job: %s | %s | %s", job_input.company, job_input.title, job_input.url)
            posting = self.normalizer.normalize(job_input)
            fingerprint = JobFingerprint.from_job_input(job_input)

            if fingerprint.url and fingerprint.url in seen_urls:
                reason = "Duplicate URL in current search batch"
                logger.info("duplicate result: %s", reason)
                matches.append(self._build_duplicate_match(job_input, posting, fingerprint, reason, 1.0))
                continue

            company_title_key = (
                normalize_company_name(job_input.company),
                normalize_title(job_input.title),
            )
            if company_title_key in seen_company_title:
                reason = "Duplicate company and title in current search batch"
                logger.info("duplicate result: %s", reason)
                matches.append(self._build_duplicate_match(job_input, posting, fingerprint, reason, 0.95))
                continue

            if fingerprint.description_hash and fingerprint.description_hash in seen_hashes:
                reason = "Duplicate description hash in current search batch"
                logger.info("duplicate result: %s", reason)
                matches.append(self._build_duplicate_match(job_input, posting, fingerprint, reason, 0.98))
                continue

            if fingerprint.url:
                seen_urls.add(fingerprint.url)
            seen_company_title.add(company_title_key)
            if fingerprint.description_hash:
                seen_hashes.add(fingerprint.description_hash)

            duplicate_check = await self.duplicate_detector.check_duplicate(job_input)
            logger.info("duplicate result: %s for %s", duplicate_check, job_input.title)
            if duplicate_check.is_duplicate:
                matches.append(self._build_duplicate_match(
                    job_input,
                    posting,
                    fingerprint,
                    duplicate_check.reason,
                    duplicate_check.confidence_score,
                    duplicate_check.matched_job_id,
                ))
                continue

            if duplicate_check.confidence_score >= POSSIBLE_DUPLICATE_THRESHOLD:
                logger.info(
                    "possible duplicate signal: %s (%s)",
                    duplicate_check.reason,
                    duplicate_check.confidence_score,
                )

            score = self.scoring.score(posting, self.profile)
            posting.match_score = score
            logger.info("score: %s for %s", score, job_input.title)

            save_result = await self.memory_store.save_job(posting)
            logger.info("save result: %s", save_result)

            match = JobMatch(
                job_input=job_input,
                posting=posting,
                fingerprint=fingerprint,
                decision=JobDecision(
                    match_score=score,
                    duplicate=False,
                    recommendation="save",
                    reason="Persisted new job to MCP memory",
                    confidence_score=1.0,
                ),
                memory_job_id=save_result.get("id"),
                saved=True,
            )
            matches.append(match)

        return matches

    async def _search_all_sources(self) -> list[JobInput]:
        results: list[JobInput] = []
        for provider in self.providers:
            provider_results = provider.search(self.profile)
            if isinstance(provider_results, Iterable):
                results.extend(provider_results)
        return results

    def _build_duplicate_match(
        self,
        job_input: JobInput,
        posting: NormalizedJobPosting,
        fingerprint: JobFingerprint,
        reason: str,
        confidence: float,
        matched_job_id: int | None = None,
    ) -> JobMatch:
        return JobMatch(
            job_input=job_input,
            posting=posting,
            fingerprint=fingerprint,
            decision=JobDecision(
                match_score=0.0,
                duplicate=True,
                recommendation="discard",
                reason=reason,
                confidence_score=confidence,
            ),
            memory_job_id=matched_job_id,
            saved=False,
        )

    def _fingerprint(self, posting: NormalizedJobPosting) -> JobFingerprint:
        return JobFingerprint.from_normalized_posting(posting)
