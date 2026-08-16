from __future__ import annotations
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
from ..lifecycle.url import normalize_url
from ..lifecycle import (
    CanonicalJobResolver,
    process_discovered_job,
)
from ..lifecycle.evaluation_service import EvaluationService
from ..lifecycle.process import DiscoveryRunTracker
from ..lifecycle.types import PostingDisposition

logger = logging.getLogger(__name__)


class JobSearchWorkflow:
    """Orchestrates search, lifecycle classification, scoring, and persistence.

    Company+title matches are canonical-role signals (possible REPOST), not
    automatic discards. Posting-level duplicates use URL / external_job_id.
    """

    def __init__(
        self,
        profile: JobSearchProfile,
        providers: list[JobSearchProvider],
        normalizer: JobNormalizer,
        scoring: ScoreCalculator,
        memory_store: MemoryStore,
        duplicate_detector: DuplicateDetector | None = None,
        lifecycle_resolver: CanonicalJobResolver | None = None,
        evaluation_service: EvaluationService | None = None,
    ):
        self.profile = profile
        self.providers = providers
        self.normalizer = normalizer
        self.scoring = scoring
        self.memory_store = memory_store
        self.duplicate_detector = duplicate_detector or DuplicateDetector(self.memory_store)
        self.lifecycle_resolver = lifecycle_resolver
        self.evaluation_service = evaluation_service
        if self.evaluation_service is None and lifecycle_resolver is not None:
            store = getattr(lifecycle_resolver, "store", None)
            if store is not None and hasattr(store, "save_job_evaluation"):
                self.evaluation_service = EvaluationService(store)

    async def execute(self) -> list[JobMatch]:
        job_inputs = await self._search_all_sources()
        matches: list[JobMatch] = []
        seen_urls: set[str] = set()
        seen_external_ids: set[tuple[str, str]] = set()
        tracker = DiscoveryRunTracker(source="workflow")

        for job_input in job_inputs:
            logger.info("received job: %s | %s | %s", job_input.company, job_input.title, job_input.url)
            posting = self.normalizer.normalize(job_input)
            fingerprint = JobFingerprint.from_job_input(job_input)
            normalized = normalize_url(fingerprint.url)

            if normalized and normalized in seen_urls:
                reason = "Duplicate URL in current search batch"
                logger.info("duplicate result: %s", reason)
                matches.append(self._build_duplicate_match(job_input, posting, fingerprint, reason, 1.0))
                continue

            external_key = None
            if job_input.source and job_input.external_job_id:
                external_key = (job_input.source, job_input.external_job_id)
                if external_key in seen_external_ids:
                    reason = "Duplicate source+external_job_id in current search batch"
                    logger.info("duplicate result: %s", reason)
                    matches.append(
                        self._build_duplicate_match(job_input, posting, fingerprint, reason, 1.0)
                    )
                    continue

            # description_hash is NOT posting identity — do not batch-discard on it.
            # Lifecycle classifier must evaluate identical-JD reposts.

            if normalized:
                seen_urls.add(normalized)
            if external_key:
                seen_external_ids.add(external_key)

            # Prefer lifecycle path when a resolver is configured.
            if self.lifecycle_resolver is not None:
                match = await self._process_with_lifecycle(job_input, posting, fingerprint, tracker)
                matches.append(match)
                continue

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

            if (
                duplicate_check.confidence_score >= POSSIBLE_DUPLICATE_THRESHOLD
                or duplicate_check.possible_canonical_match
            ):
                logger.info(
                    "canonical/possible-duplicate signal: %s (%s)",
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

        if self.lifecycle_resolver is not None:
            store = getattr(self.lifecycle_resolver, "store", None)
            if store is not None and hasattr(store, "save_discovery_run"):
                await tracker.persist(store)

        return matches

    async def _process_with_lifecycle(
        self,
        job_input: JobInput,
        posting: NormalizedJobPosting,
        fingerprint: JobFingerprint,
        tracker: DiscoveryRunTracker,
    ) -> JobMatch:
        assert self.lifecycle_resolver is not None
        score = self.scoring.score(posting, self.profile)
        posting.match_score = score

        metadata = job_input.metadata or {}
        raw = {
            "company": job_input.company,
            "title": job_input.title,
            "url": job_input.url,
            "description": job_input.description,
            "source": job_input.source,
            "location": job_input.location,
            "external_job_id": job_input.external_job_id,
            "remote_status": metadata.get("remote_status"),
            "salary": metadata.get("salary"),
            "posted_date": (
                job_input.posted_date.isoformat()
                if job_input.posted_date
                else metadata.get("posted_date")
            ),
            "metadata": metadata,
        }
        result = await process_discovered_job(
            raw,
            self.lifecycle_resolver,
            match_score=score,
            persist=True,
        )
        tracker.record(result)

        disposition = result.classification.disposition
        if disposition == PostingDisposition.SAME_POSTING:
            recommendation = "update_existing"
            duplicate = True
            reason = result.classification.reason
        elif disposition == PostingDisposition.REPOST:
            recommendation = "save_repost"
            duplicate = False
            reason = result.classification.reason
        else:
            recommendation = "save"
            duplicate = False
            reason = result.classification.reason

        memory_id = None
        if result.job_posting:
            memory_id = result.job_posting.get("id")
        elif result.canonical_job:
            memory_id = result.canonical_job.get("id")

        if (
            self.evaluation_service is not None
            and result.job_posting
            and result.job_posting.get("id")
        ):
            await self.evaluation_service.persist_evaluation(
                posting_id=str(result.job_posting["id"]),
                match_score=score,
                recommendation=recommendation,
                reason=reason,
                metadata={
                    "disposition": disposition.value,
                    "canonical_similarity_score": result.classification.canonical_similarity_score,
                },
            )

        return JobMatch(
            job_input=job_input,
            posting=posting,
            fingerprint=fingerprint,
            decision=JobDecision(
                match_score=score,
                duplicate=duplicate,
                recommendation=recommendation,
                reason=reason,
                confidence_score=1.0,
            ),
            memory_job_id=memory_id,
            saved=result.persisted and disposition != PostingDisposition.SAME_POSTING,
        )

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
        matched_job_id: int | str | None = None,
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
