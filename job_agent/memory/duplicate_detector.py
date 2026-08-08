from __future__ import annotations

from typing import Any

from ..models.types import DuplicateResult, JobFingerprint, JobInput
from ..memory.client import MemoryStore
from ..memory.fingerprint import (
    compute_description_hash,
    normalize_company_key,
    normalize_description_text,
    normalize_title_key,
)
from ..utils.normalization import (
    extract_keyword_set,
    extract_role_family,
    extract_skill_set,
    normalize_location,
)

AUTOMATIC_DUPLICATE_THRESHOLD = 90.0
POSSIBLE_DUPLICATE_THRESHOLD = 70.0


class DuplicateDetector:
    def __init__(self, memory_store: MemoryStore):
        self.memory_store = memory_store

    async def check_duplicate(self, job_input: JobInput) -> DuplicateResult:
        current_fingerprint = JobFingerprint.from_job_input(job_input)
        history = await self.memory_store.get_history()

        if not history:
            return DuplicateResult(
                is_duplicate=False,
                confidence_score=0.0,
                matched_job_id=None,
                reason="no history available",
            )

        exact_result = self._check_exact_matches(current_fingerprint, history)
        if exact_result.is_duplicate:
            return exact_result

        return self._check_similarity(current_fingerprint, history)

    def _check_exact_matches(
        self,
        fingerprint: JobFingerprint,
        history: list[dict[str, Any]],
    ) -> DuplicateResult:
        for item in history:
            item_url = item.get("url")
            item_title = item.get("title", "")
            item_company = item.get("company", "")
            item_description_hash = item.get("description_hash")

            if fingerprint.url and item_url and fingerprint.url == item_url:
                return DuplicateResult(
                    is_duplicate=True,
                    confidence_score=100.0,
                    matched_job_id=item.get("id"),
                    reason="same URL",
                )

            if (
                fingerprint.description_hash
                and item_description_hash
                and fingerprint.description_hash == item_description_hash
            ):
                return DuplicateResult(
                    is_duplicate=True,
                    confidence_score=98.0,
                    matched_job_id=item.get("id"),
                    reason="same description hash",
                )

            if (
                fingerprint.company_key == normalize_company_key(item_company)
                and fingerprint.normalized_title == normalize_title_key(item_title)
            ):
                return DuplicateResult(
                    is_duplicate=True,
                    confidence_score=95.0,
                    matched_job_id=item.get("id"),
                    reason="same company and normalized title",
                )

        return DuplicateResult(
            is_duplicate=False,
            confidence_score=0.0,
            matched_job_id=None,
            reason="no exact match",
        )

    def _check_similarity(
        self,
        fingerprint: JobFingerprint,
        history: list[dict[str, Any]],
    ) -> DuplicateResult:
        best_result = DuplicateResult(
            is_duplicate=False,
            confidence_score=0.0,
            matched_job_id=None,
            reason="no similar job found",
        )

        for item in history:
            existing_fingerprint = JobFingerprint(
                company_name=item.get("company", ""),
                company_key=normalize_company_key(item.get("company", "")),
                title=item.get("title", ""),
                normalized_title=normalize_title_key(item.get("title", "")),
                role_family=extract_role_family(item.get("title", "")),
                keyword_set=frozenset(
                    extract_keyword_set(item.get("title", ""), item.get("description"))
                ),
                skill_set=frozenset(
                    extract_skill_set(item.get("title", ""), item.get("description"))
                ),
                location_key=normalize_location(item.get("location")),
                description_hash=item.get("description_hash"),
                normalized_description=normalize_description_text(item.get("description")),
                url=item.get("url"),
            )

            score = self._calculate_similarity(fingerprint, existing_fingerprint)
            if score <= best_result.confidence_score:
                continue

            same_company = fingerprint.company_key == existing_fingerprint.company_key
            matched_job_id = item.get("id") if same_company else None
            reason = self._describe_similarity(fingerprint, existing_fingerprint, score)
            is_duplicate = same_company and score >= AUTOMATIC_DUPLICATE_THRESHOLD

            best_result = DuplicateResult(
                is_duplicate=is_duplicate,
                confidence_score=round(score, 2),
                matched_job_id=matched_job_id,
                reason=reason,
            )

        return best_result

    def _describe_similarity(
        self,
        candidate: JobFingerprint,
        existing: JobFingerprint,
        score: float,
    ) -> str:
        same_company = candidate.company_key == existing.company_key
        if score >= AUTOMATIC_DUPLICATE_THRESHOLD:
            return "automatic duplicate based on company, title, and description similarity"
        if score >= POSSIBLE_DUPLICATE_THRESHOLD:
            if same_company:
                return "possible duplicate within same company"
            return "possible duplicate across companies"
        return "no duplicate signal"

    def _calculate_similarity(
        self,
        candidate: JobFingerprint,
        existing: JobFingerprint,
    ) -> float:
        score = 0.0

        if candidate.company_key == existing.company_key:
            score += 35.0

        if (
            candidate.role_family
            and existing.role_family
            and candidate.role_family == existing.role_family
        ):
            score += 20.0

        score += 25.0 * self._text_similarity(
            candidate.normalized_title,
            existing.normalized_title,
        )
        score += 20.0 * self._text_similarity(
            candidate.normalized_description,
            existing.normalized_description,
        )

        return min(score, 100.0)

    def _text_similarity(self, left: str | None, right: str | None) -> float:
        if not left or not right:
            return 0.0

        left_tokens = set(left.split())
        right_tokens = set(right.split())
        if not left_tokens or not right_tokens:
            return 0.0

        return len(left_tokens & right_tokens) / max(len(left_tokens), len(right_tokens))
